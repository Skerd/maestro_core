import {beforeEach, describe, expect, it, vi} from "vitest";

const state = vi.hoisted(() => ({
    eachBatch: undefined as undefined | ((args: object) => Promise<void>),
}));
const publishWithRetry = vi.fn();

vi.mock("@coreModule/connections/connectToKafka", () => ({
    ensureKafkaTopic: vi.fn(async () => {}),
    isKafkaConnected: () => true,
    getConsumerInstance: () => ({
        connect: vi.fn(async () => {}),
        subscribe: vi.fn(async () => {}),
        run: vi.fn(async ({eachBatch}: {eachBatch: (args: object) => Promise<void>}) => {
            state.eachBatch = eachBatch;
        }),
    }),
}));
vi.mock("@coreModule/environment", () => ({
    KAFKA: {
        ENABLED: true,
        TOPICS: {CRON_EXECUTE: "cron_execute"},
        CONSUMER_GROUP: {CRON_EXECUTE: "cron_group"},
        CONSUMER_MAX_RETRIES: 3,
        PRODUCER_MAX_RETRIES: 3,
    },
}));
vi.mock("@coreModule/kafka/kafkaProducer", () => ({
    publishWithRetry: (...args: unknown[]) => publishWithRetry(...args),
}));
vi.mock("@coreModule/kafka/consumerRegistry", () => ({
    KafkaConsumerRegistration: class {
        register = vi.fn(async () => {});
        startHeartbeat = vi.fn();
        stopHeartbeat = vi.fn();
        unregister = vi.fn(async () => {});
    },
}));
vi.mock("@coreModule/database/schemas/cronJob/cronJob", () => ({default: {find: vi.fn()}}));

import {KafkaQueueAdapter} from "../adapters/kafkaQueueAdapter";

function cronMessage(deliveryAttempt?: number) {
    return {jobId: "job-1", attempt: 1, handler: "demo", enqueuedAt: "2026-10-22T10:00:00Z", deliveryAttempt};
}

async function deliverFailing(message: object) {
    await state.eachBatch!({
        batch: {topic: "cron_execute", partition: 0, messages: [{offset: "7", value: Buffer.from(JSON.stringify(message))}]},
        heartbeat: vi.fn(async () => {}),
    });
}

describe("KafkaQueueAdapter failure handling", () => {
    beforeEach(async () => {
        publishWithRetry.mockReset();
        await new KafkaQueueAdapter().startConsumer(async () => {
            throw new Error("handler crashed");
        });
    });

    it("re-enqueues a failed message with its delivery attempt counted in the message", async () => {
        await deliverFailing(cronMessage());

        expect(publishWithRetry).toHaveBeenCalledTimes(1);
        const [topic, payload] = publishWithRetry.mock.calls[0];
        expect(topic).toBe("cron_execute");
        expect(JSON.parse(payload.value)).toMatchObject({jobId: "job-1", attempt: 1, deliveryAttempt: 1});
    });

    it("keeps counting across re-enqueues, which get new offsets", async () => {
        await deliverFailing(cronMessage(1));

        expect(JSON.parse(publishWithRetry.mock.calls[0][1].value)).toMatchObject({deliveryAttempt: 2});
    });

    it("sends the message to the DLQ once it reaches the retry limit", async () => {
        await deliverFailing(cronMessage(2));

        expect(publishWithRetry).toHaveBeenCalledTimes(1);
        const [topic, payload] = publishWithRetry.mock.calls[0];
        expect(topic).toBe("cron_execute_dlq");
        expect(JSON.parse(payload.value)).toMatchObject({originalTopic: "cron_execute", error: "handler crashed", retryCount: 3});
    });
});
