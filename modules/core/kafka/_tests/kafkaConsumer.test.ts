import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

const state = vi.hoisted(() => ({
    eachMessage: undefined as undefined | ((payload: any) => Promise<void>),
    handlers: new Map<string, (event: any) => void>(),
    subscribeError: undefined as Error | undefined,
}));
const publishWithRetry = vi.fn();
const registration = vi.hoisted(() => ({
    register: vi.fn(async () => {}),
    startHeartbeat: vi.fn(),
    stopHeartbeat: vi.fn(),
}));

const consumer = {
    events: {GROUP_JOIN: "consumer.group_join", STOP: "consumer.stop", CRASH: "consumer.crash"},
    on: vi.fn((event: string, handler: (event: any) => void) => {
        state.handlers.set(event, handler);
    }),
    connect: vi.fn(async () => {}),
    subscribe: vi.fn(async () => {
        if (state.subscribeError) throw state.subscribeError;
    }),
    run: vi.fn(async ({eachMessage}: {eachMessage: (payload: any) => Promise<void>}) => {
        state.eachMessage = eachMessage;
    }),
};

vi.mock("@coreModule/connections/connectToKafka", () => ({
    getConsumerInstance: () => consumer,
    ensureKafkaTopic: async () => {},
}));
vi.mock("@coreModule/connections/connectToRedis", () => ({}));
vi.mock("@coreModule/kafka/kafkaProducer", () => ({
    publishWithRetry: (...args: unknown[]) => publishWithRetry(...args),
}));
vi.mock("@coreModule/environment", () => ({
    KAFKA: {ENABLED: true, CONSUMER_MAX_RETRIES: 3, PRODUCER_MAX_RETRIES: 3, TOPICS: {}, CONSUMER_GROUP: {}},
}));
vi.mock("@coreModule/utilities/database/user", () => ({}));
vi.mock("@coreModule/database/schemas/apiAccess/apiAccess", () => ({default: class {}}));
vi.mock("@coreModule/utilities/serviceMetrics/serviceCounters", () => ({
    kafkaCounter: {recordSuccess: vi.fn(), recordFailure: vi.fn()},
}));
vi.mock("@coreModule/utilities/timing/metricsAggregator", () => ({metricsAggregator: {addSample: vi.fn()}}));
vi.mock("@coreModule/kafka/consumerRegistry", () => ({
    KafkaConsumerRegistration: class {
        register = registration.register;
        startHeartbeat = registration.startHeartbeat;
        stopHeartbeat = registration.stopHeartbeat;
    },
}));

const processEvent = vi.fn();
const resume = vi.fn();
const pause = vi.fn(() => resume);

async function start() {
    const {addKafkaTopicConsumer} = await import("../kafkaConsumer");
    await addKafkaTopicConsumer(undefined, {
        registryKey: "test",
        displayName: "Test",
        groupId: "group",
        topic: "topic",
        expectedEventType: "test_event",
        processEvent,
    });
}

/** Delivers offset 7 once; resolves to the error message, or "ok". */
async function deliver(eventType = "test_event"): Promise<string> {
    return state.eachMessage!({
        topic: "topic",
        partition: 2,
        message: {offset: "7", key: Buffer.from("key"), value: Buffer.from(JSON.stringify({eventType}))},
        heartbeat: async () => {},
        pause,
    }).then(() => "ok", (error: Error) => error.message);
}

describe("addKafkaTopicConsumer", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.resetModules();
        vi.clearAllMocks();
        state.eachMessage = undefined;
        state.handlers.clear();
        state.subscribeError = undefined;
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("hands matching events to the handler and skips others", async () => {
        await start();

        expect(await deliver()).toBe("ok");
        expect(await deliver("other_event")).toBe("ok");
        expect(processEvent).toHaveBeenCalledTimes(1);
        expect(pause).not.toHaveBeenCalled();
    });

    it("pauses the partition with a growing backoff, then dead-letters on the last attempt", async () => {
        processEvent.mockRejectedValue(new Error("smtp down"));
        await start();

        expect(await deliver()).toBe("smtp down");
        expect(pause).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(4_999);
        expect(resume).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(resume).toHaveBeenCalledTimes(1);

        expect(await deliver()).toBe("smtp down");
        await vi.advanceTimersByTimeAsync(19_999);
        expect(resume).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(resume).toHaveBeenCalledTimes(2);

        expect(await deliver()).toBe("ok");
        expect(pause).toHaveBeenCalledTimes(2);
        expect(publishWithRetry).toHaveBeenCalledTimes(1);
        const [dlqTopic, dlqMessage] = publishWithRetry.mock.calls[0];
        expect(dlqTopic).toBe("topic_dlq");
        expect(JSON.parse(dlqMessage.value)).toMatchObject({
            originalTopic: "topic",
            originalPartition: 2,
            originalOffset: "7",
            retryCount: 3,
            error: {message: "smtp down"},
        });
    });

    it("redelivers instead of committing when the DLQ is unreachable", async () => {
        processEvent.mockRejectedValue(new Error("smtp down"));
        publishWithRetry.mockRejectedValue(new Error("broker down"));
        await start();

        await deliver();
        await deliver();
        expect(await deliver()).toBe("smtp down");
        expect(publishWithRetry).toHaveBeenCalledTimes(1);
        expect(pause).toHaveBeenCalledTimes(3);
    });

    it("starts counting attempts again once a message succeeds", async () => {
        processEvent.mockRejectedValueOnce(new Error("smtp down")).mockResolvedValueOnce(undefined);
        await start();

        await deliver();
        expect(await deliver()).toBe("ok");
        processEvent.mockRejectedValue(new Error("smtp down"));
        await deliver();
        await deliver();
        expect(publishWithRetry).not.toHaveBeenCalled();
    });

    it("heartbeats only while the consumer is in its group", async () => {
        await start();

        expect(registration.register).toHaveBeenCalledTimes(1);
        expect(registration.startHeartbeat).not.toHaveBeenCalled();
        state.handlers.get(consumer.events.GROUP_JOIN)!({});
        expect(registration.startHeartbeat).toHaveBeenCalledTimes(1);
        state.handlers.get(consumer.events.STOP)!({});
        expect(registration.stopHeartbeat).toHaveBeenCalledTimes(1);
    });

    it("does not register a consumer whose subscription failed", async () => {
        state.subscribeError = new Error("unknown topic");

        await expect(start()).rejects.toThrow("unknown topic");
        expect(registration.register).not.toHaveBeenCalled();
        expect(consumer.run).not.toHaveBeenCalled();
    });
});
