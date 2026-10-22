/**
 * Kafka Dead Letters
 *
 * A consumer that gives up on a message (see kafkaConsumer) writes it to the
 * dead-letter topic `{topic}_dlq`. This module writes those envelopes, counts
 * the ones not resent yet, and replays them onto their original topic.
 *
 * Replay progress is the committed offset of the consumer group
 * `{topic}_dlq-replay`: a dead letter is replayed once, and a message that
 * fails again comes back as a new dead letter. A Redis lock per topic keeps
 * two replays (panel, `yarn kafka:replay-dlq`) from resending the same letters.
 *
 * @module kafka/deadLetters
 */

import {randomUUID} from "crypto";
import type {Admin, KafkaMessage} from "kafkajs";
import {getConsumerInstance, releaseConsumerInstance, withKafkaAdmin} from "@coreModule/connections/connectToKafka";
import {redisReleaseLock, redisTryAcquireOrRenewLock} from "@coreModule/connections/connectToRedis";
import {publishWithRetry} from "@coreModule/kafka/kafkaProducer";
import {KAFKA} from "@coreModule/environment";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import type {KafkaDeadLetterBacklog} from "armonia/src/modules/core/api/auxiliary/private/serverHealth/serverHealth.dto";

const logger = getLogger("kafka_dead_letters");

/** Suffix appended to topic name for Dead Letter Queue */
export const DLQ_TOPIC_SUFFIX = '_dlq';

/** A replay gives up after this long, so a request never hangs on it. */
const REPLAY_TIMEOUT_MS = 2 * 60_000;

/** Outlives the replay timeout, so the lock never expires under a running replay. */
const REPLAY_LOCK_TTL_SECONDS = 3 * 60;

/** Envelope written to the DLQ. */
export type DeadLetter = {
    originalTopic: string;
    originalPartition: number;
    originalOffset: string;
    originalMessage?: string;
    error: {message: string; stack?: string};
    timestamp: string;
    retryCount: number;
};

function replayGroupId(dlqTopic: string): string {
    return `${dlqTopic}-replay`;
}

/**
 * Send failed message to Dead Letter Queue (DLQ)
 *
 * After a message has exceeded the maximum retry attempts, it is sent to a DLQ
 * topic for manual inspection and replay. Throws when the DLQ is unreachable,
 * so the caller redelivers the message instead of losing it.
 */
export async function sendToDeadLetterQueue(topic: string, partition: number, message: KafkaMessage, error: Error, attempts: number, log: serverLogger): Promise<void> {
    const dlqTopic = `${topic}${DLQ_TOPIC_SUFFIX}`;
    const deadLetter: DeadLetter = {
        originalTopic: topic,
        originalPartition: partition,
        originalOffset: message.offset,
        originalMessage: message.value?.toString(),
        error: {
            message: error.message,
            stack: error.stack
        },
        timestamp: new Date().toISOString(),
        retryCount: attempts
    };

    await publishWithRetry(dlqTopic, {
        key: message.key?.toString() || "unknown",
        value: JSON.stringify(deadLetter),
        headers: {
            "original-topic": topic,
            "error-type": error.constructor.name,
            "dlq-timestamp": deadLetter.timestamp
        }
    }, KAFKA.PRODUCER_MAX_RETRIES, log);

    log.warn(`Sent message to DLQ: ${dlqTopic}`);
}

/**
 * Per partition, the offsets still to replay: from the replay group's committed
 * offset (the oldest retained one when it has none) up to the current end.
 */
async function getPendingRanges(admin: Admin, dlqTopic: string): Promise<{partition: number; from: number; end: number}[]> {
    const [ends, [committed]] = await Promise.all([
        admin.fetchTopicOffsets(dlqTopic),
        admin.fetchOffsets({groupId: replayGroupId(dlqTopic), topics: [dlqTopic]}),
    ]);
    const committedByPartition = new Map(committed.partitions.map((p) => [p.partition, Number(p.offset)]));
    return ends
        .map((p) => ({
            partition: p.partition,
            from: Math.max(committedByPartition.get(p.partition) ?? -1, Number(p.low)),
            end: Number(p.high),
        }))
        .filter((range) => range.from < range.end);
}

/**
 * Dead letters not resent yet, per original topic; topics with none are left
 * out. Reads offsets only, never the messages.
 */
export async function getDeadLetterBacklog(): Promise<KafkaDeadLetterBacklog[]> {
    return withKafkaAdmin(async (admin) => {
        const dlqTopics = (await admin.listTopics()).filter((topic) => topic.endsWith(DLQ_TOPIC_SUFFIX));
        const backlog = await Promise.all(dlqTopics.map(async (dlqTopic) => {
            const ranges = await getPendingRanges(admin, dlqTopic);
            return {
                topic: dlqTopic.slice(0, -DLQ_TOPIC_SUFFIX.length),
                pending: ranges.reduce((sum, range) => sum + range.end - range.from, 0),
            };
        }));
        return backlog
            .filter((entry) => entry.pending > 0)
            .sort((a, b) => a.topic.localeCompare(b.topic));
    });
}

/**
 * Replays the dead letters of `topic` onto it, up to the end of its DLQ as it
 * was when the replay started; letters dead-lettered meanwhile wait for the
 * next replay. Needs a connected producer.
 *
 * @param topic - Original topic (its DLQ is `{topic}_dlq`)
 * @param options.dryRun - Only list the letters; nothing is sent or committed
 * @param options.onLetter - Called for each letter, before it is resent
 * @returns How many letters were replayed (or listed), or null when another
 *          replay of this topic is running
 */
export async function replayDeadLetters(
    topic: string,
    options: {dryRun?: boolean; onLetter?: (letter: DeadLetter, dlqOffset: string) => void} = {},
): Promise<number | null> {
    const dlqTopic = `${topic}${DLQ_TOPIC_SUFFIX}`;
    const lockKey = `kafka:dlq-replay:${topic}`;
    const lockOwner = randomUUID();
    if (!(await redisTryAcquireOrRenewLock(lockKey, lockOwner, REPLAY_LOCK_TTL_SECONDS))) {
        return null;
    }

    try {
        const ranges = await withKafkaAdmin((admin) => getPendingRanges(admin, dlqTopic));
        if (ranges.length === 0) {
            return 0;
        }
        const ends = new Map(ranges.map((range) => [range.partition, range.end]));

        const consumer = getConsumerInstance(replayGroupId(dlqTopic));
        if (!consumer) {
            throw new Error("Kafka is disabled");
        }

        let count = 0;
        try {
            await consumer.connect();
            await consumer.subscribe({topics: [dlqTopic], fromBeginning: true});

            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => finish(new Error(`Replay of ${dlqTopic} timed out after ${REPLAY_TIMEOUT_MS} ms`)), REPLAY_TIMEOUT_MS);
                function finish(error?: unknown): void {
                    clearTimeout(timeout);
                    if (error) reject(error);
                    else resolve();
                }
                consumer.on(consumer.events.CRASH, ({payload}) => finish(payload.error));

                // Offsets are committed by hand, and only up to the last replayed
                // letter: committing past `end` would skip later dead letters.
                consumer.run({
                    autoCommit: false,
                    eachBatchAutoResolve: false,
                    eachBatch: async ({batch, pause, commitOffsetsIfNecessary}) => {
                        const end = ends.get(batch.partition);
                        let next: number | undefined;
                        try {
                            for (const message of batch.messages) {
                                if (end === undefined || Number(message.offset) >= end) break;
                                const letter = JSON.parse(message.value?.toString() || "{}") as DeadLetter;
                                options.onLetter?.(letter, message.offset);
                                if (!options.dryRun) {
                                    await publishWithRetry(letter.originalTopic, {
                                        key: message.key,
                                        value: letter.originalMessage ?? null,
                                        headers: {"replayed-from": dlqTopic},
                                    });
                                }
                                count++;
                                next = Number(message.offset) + 1;
                            }
                        } catch (error) {
                            pause();
                            finish(error);
                            throw error;
                        } finally {
                            if (next !== undefined && !options.dryRun) {
                                await commitOffsetsIfNecessary({topics: [{topic: dlqTopic, partitions: [{partition: batch.partition, offset: String(next)}]}]});
                            }
                        }
                        if (end !== undefined && next !== undefined && next >= end) {
                            ends.delete(batch.partition);
                            if (ends.size === 0) finish();
                        }
                    },
                }).catch(finish);
            });
        } finally {
            await releaseConsumerInstance(consumer);
        }

        logger.info(`${options.dryRun ? "Listed" : "Replayed"} ${count} dead letter(s) of ${dlqTopic}`);
        return count;
    } finally {
        await redisReleaseLock(lockKey, lockOwner);
    }
}
