/**
 * Replay a Kafka dead-letter topic: every message a consumer gave up on is
 * published again, unchanged, on its original topic — run it once the cause
 * (SMTP down, bad config, a bug) is fixed. Every consumer group on that topic
 * receives the message again (api-access has two). The Server Performance page
 * resends all topics the same way (core kafka/deadLetters).
 *
 * A message is replayed once, and a later run only picks up what was
 * dead-lettered since. A message that fails again lands back in the DLQ as a
 * new entry. The dry run lists what would be replayed and commits nothing.
 *
 * Usage (from maestro/, with the original topic name):
 *   yarn kafka:replay-dlq forgot-password-email             # dry run
 *   yarn kafka:replay-dlq forgot-password-email --execute   # replays
 * In a deployed container (compiled build, no .ts sources):
 *   docker exec maestroApi-<instance> node -r tsconfig-paths/register scripts/replayKafkaDeadLetters.js <topic> [--execute]
 */

import {connectToRedis, isRedisConnected} from "@coreModule/connections/connectToRedis";
import {disconnectFromKafka, getProducerInstance} from "@coreModule/connections/connectToKafka";
import {DLQ_TOPIC_SUFFIX, replayDeadLetters} from "@coreModule/kafka/deadLetters";

/** How long to wait for Redis, which holds the replay lock. */
const REDIS_CONNECT_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
    const topic = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
    if (!topic) {
        throw new Error("Pass the original topic name, e.g. forgot-password-email");
    }
    const execute = process.argv.includes("--execute");

    const producer = getProducerInstance();
    if (!producer) {
        throw new Error("Kafka is disabled (KAFKA_ENABLED)");
    }

    await connectToRedis();
    const redisDeadline = Date.now() + REDIS_CONNECT_TIMEOUT_MS;
    while (!isRedisConnected()) {
        if (Date.now() > redisDeadline) throw new Error("Redis is not reachable; it holds the replay lock");
        await new Promise((resolve) => setTimeout(resolve, 200));
    }

    let count: number | null;
    try {
        await producer.connect();
        count = await replayDeadLetters(topic, {
            dryRun: !execute,
            onLetter: (letter, dlqOffset) => console.log(
                `${topic}${DLQ_TOPIC_SUFFIX}#${dlqOffset}: ${letter.originalTopic}#${letter.originalOffset}, ${letter.retryCount} attempt(s), dead-lettered ${letter.timestamp}: ${letter.error?.message}`
            ),
        });
    } finally {
        await disconnectFromKafka();
    }

    if (count === null) {
        throw new Error(`A replay of ${topic} is already running`);
    }
    console.log(`${count} dead letter(s) ${execute ? "replayed" : "would be replayed"}.`);
    if (!execute) console.log("Dry run only — pass --execute to replay.");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("replayKafkaDeadLetters failed:", error);
        process.exit(1);
    });
