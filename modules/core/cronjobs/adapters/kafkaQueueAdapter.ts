import {getConsumerInstance, getProducerInstance} from "@coreModule/connections/connectToKafka";
import {KAFKA} from "@coreModule/environment";
import {getLogger} from "@coreModule/loggers/serverLog";
import {getRedisClient, isRedisConnected} from "@coreModule/connections/connectToRedis";
import {KafkaConsumerRegistration} from "@coreModule/kafka/consumerRegistry";
import type {CronQueueMessage, QueueAdapter} from "@coreModule/cronjobs/adapters/queueAdapter";

const logger = getLogger("cron_kafka");
const DLQ_SUFFIX = "_dlq";
const RETRY_TTL = 3600;

export class KafkaQueueAdapter implements QueueAdapter {
    private registration: KafkaConsumerRegistration | null = null;

    async enqueue(msg: CronQueueMessage): Promise<void> {
        const producer = getProducerInstance();
        await producer.send({
            topic: KAFKA.TOPICS.CRON_EXECUTE,
            messages: [{value: JSON.stringify(msg)}],
        });
    }

    async startConsumer(onMessage: (msg: CronQueueMessage) => Promise<void>): Promise<void> {
        const consumer = getConsumerInstance(KAFKA.CONSUMER_GROUP.CRON_EXECUTE);
        const topic = KAFKA.TOPICS.CRON_EXECUTE;

        this.registration = new KafkaConsumerRegistration(
            "cronJobExecutor",
            "Cron job executor",
            KAFKA.CONSUMER_GROUP.CRON_EXECUTE,
            topic,
        );
        await this.registration.register();
        this.registration.startHeartbeat();

        await consumer.subscribe({topic, fromBeginning: false});
        await consumer.run({
            eachMessage: async ({topic: t, partition, message}) => {
                const raw = message.value?.toString();
                if (!raw) return;
                let parsed: CronQueueMessage;
                try {
                    parsed = JSON.parse(raw) as CronQueueMessage;
                } catch {
                    logger.err("Invalid cron queue message JSON");
                    return;
                }

                if (parsed.notBefore) {
                    const nb = new Date(parsed.notBefore).getTime();
                    if (Date.now() < nb) {
                        await this.enqueue({...parsed, notBefore: parsed.notBefore});
                        return;
                    }
                }

                try {
                    await onMessage(parsed);
                } catch (e: unknown) {
                    const msg = e instanceof Error ? e.message : String(e);
                    logger.err(`Cron kafka handler failed: ${msg}`);
                    await this.handleFailure(t, partition, message.offset, raw, e);
                }
            },
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
