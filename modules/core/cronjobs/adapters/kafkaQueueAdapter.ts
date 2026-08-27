import {Types} from "mongoose";
import {getConsumerInstance, getProducerInstance, isKafkaConnected} from "@coreModule/connections/connectToKafka";
import {KAFKA} from "@coreModule/environment";
import {getLogger} from "@coreModule/loggers/serverLog";
import {getRedisClient, isRedisConnected} from "@coreModule/connections/connectToRedis";
import {KafkaConsumerRegistration} from "@coreModule/kafka/consumerRegistry";
import {publishWithRetry} from "@coreModule/kafka/kafkaProducer";
import CronJobModel from "@coreModule/database/schemas/cronJob/cronJob";
import {resolveMissedRunPolicy, selectMessagesToRun} from "@coreModule/cronjobs/engine/missedRunPolicy";
import type {CronQueueMessage, QueueAdapter} from "@coreModule/cronjobs/adapters/queueAdapter";

const logger = getLogger("cron_kafka");
const DLQ_SUFFIX = "_dlq";
const RETRY_TTL = 3600;

type BatchItem = {
    parsed: CronQueueMessage;
    raw: string;
    topic: string;
    partition: number;
    offset: string;
};

export class KafkaQueueAdapter implements QueueAdapter {
    private registration: KafkaConsumerRegistration | null = null;
    private burstUntil = new Map<string, number>();

    private markBurst(jobId: string): void {
        this.burstUntil.set(jobId, Date.now() + 2_000);
    }

    private inBurst(jobId: string): boolean {
        const until = this.burstUntil.get(jobId) ?? 0;
        if (Date.now() >= until) {
            this.burstUntil.delete(jobId);
            return false;
        }
        return true;
    }

    async enqueue(msg: CronQueueMessage): Promise<void> {
        if (!KAFKA.ENABLED || !isKafkaConnected()) {
            throw new Error("Kafka is not connected");
        }
        await publishWithRetry(KAFKA.TOPICS.CRON_EXECUTE, {
            key: msg.jobId,
            value: JSON.stringify(msg),
        }, KAFKA.PRODUCER_MAX_RETRIES, logger);
    }

    async startConsumer(onMessage: (msg: CronQueueMessage) => Promise<void>): Promise<void> {
        const consumer = getConsumerInstance(KAFKA.CONSUMER_GROUP.CRON_EXECUTE);
        const topic = KAFKA.TOPICS.CRON_EXECUTE;
        if (!consumer) {
            logger.warn("Kafka consumer instance unavailable — cron execute consumer not started");
            return;
        }

        this.registration = new KafkaConsumerRegistration(
            "cronJobExecutor",
            "Cron job executor",
            KAFKA.CONSUMER_GROUP.CRON_EXECUTE,
            topic,
        );
        await consumer.connect();
        await this.registration.register();
        this.registration.startHeartbeat();

        await consumer.subscribe({topic, fromBeginning: false});
        void consumer.run({
            eachBatch: async ({batch, heartbeat}) => {
                const byJob = new Map<string, BatchItem[]>();
                for (const message of batch.messages) {
                    const raw = message.value?.toString();
                    if (!raw) continue;
                    let parsed: CronQueueMessage;
                    try {
                        parsed = JSON.parse(raw) as CronQueueMessage;
                    } catch {
                        logger.err("Invalid cron queue message JSON");
                        continue;
                    }
                    if (parsed.notBefore) {
                        const nb = new Date(parsed.notBefore).getTime();
                        if (Date.now() < nb) {
                            await this.enqueue({...parsed, notBefore: parsed.notBefore});
                            continue;
                        }
                    }
                    const items = byJob.get(parsed.jobId) ?? [];
                    items.push({
                        parsed,
                        raw,
                        topic: batch.topic,
                        partition: batch.partition,
                        offset: message.offset,
                    });
                    byJob.set(parsed.jobId, items);
                }

                const jobIds = [...byJob.keys()].filter(id => Types.ObjectId.isValid(id));
                const jobs = jobIds.length === 0
                    ? []
                    : await CronJobModel.find({_id: {$in: jobIds.map(id => new Types.ObjectId(id))}})
                        .select("missedRunPolicy")
                        .lean();
                const policyById = new Map(
                    jobs.map(job => [job._id.toString(), resolveMissedRunPolicy(job.missedRunPolicy)]),
                );

                for (const [jobId, items] of byJob) {
                    const policy = policyById.get(jobId) ?? "skip";
                    if (items.length > 1) this.markBurst(jobId);
                    const toRun = selectMessagesToRun(policy, items, this.inBurst(jobId));
                    if (toRun.length < items.length) {
                        logger.debug(
                            `Missed-run policy ${policy} for ${jobId}: running ${toRun.length} of ${items.length}`,
                        );
                    }
                    for (const item of toRun) {
                        try {
                            await onMessage(item.parsed);
                        } catch (e: unknown) {
                            const errMsg = e instanceof Error ? e.message : String(e);
                            logger.err(`Cron kafka handler failed: ${errMsg}`);
                            await this.handleFailure(item.topic, item.partition, item.offset, item.raw, e);
                        }
                        await heartbeat();
                    }
                    if (toRun.length === 0) {
                        await heartbeat();
                    }
                }
            },
        }).catch((err: unknown) => {
            const errMsg = err instanceof Error ? err.message : String(err);
            logger.err(`Cron kafka consumer run loop crashed: ${errMsg}`);
        });
    }

    private async handleFailure(
        topic: string,
        partition: number,
        offset: string,
        raw: string,
        error: unknown,
    ): Promise<void> {
        const retryKey = `cron:kafka:retry:${topic}:${partition}:${offset}`;
        let retryCount = 0;
        if (isRedisConnected()) {
            const client = getRedisClient();
            retryCount = parseInt((await client.get(retryKey)) ?? "0", 10) + 1;
            await client.setEx(retryKey, RETRY_TTL, String(retryCount));
        } else {
            retryCount = 1;
        }

        const maxRetries = KAFKA.CONSUMER_MAX_RETRIES ?? 3;
        if (retryCount >= maxRetries) {
            const producer = getProducerInstance();
            if (!producer) return;
            await producer.send({
                topic: `${topic}${DLQ_SUFFIX}`,
                messages: [{
                    value: JSON.stringify({
                        originalTopic: topic,
                        originalMessage: raw,
                        error: error instanceof Error ? error.message : String(error),
                        retryCount,
                        timestamp: new Date().toISOString(),
                    }),
                }],
            });
            return;
        }

        await this.enqueue(JSON.parse(raw) as CronQueueMessage);
    }

    async stopConsumer(): Promise<void> {
        if (this.registration) {
            this.registration.stopHeartbeat();
            await this.registration.unregister();
            this.registration = null;
        }
    }

    async getQueueDepth(): Promise<number> {
        return 0;
    }
}

export const kafkaQueueAdapter = new KafkaQueueAdapter();
