import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

const send = vi.fn();
const env = vi.hoisted(() => ({connected: true}));

vi.mock("@coreModule/connections/connectToKafka", () => ({
    getProducerInstance: () => ({send}),
    isKafkaConnected: () => env.connected,
}));
vi.mock("@coreModule/environment", () => ({
    KAFKA: {ENABLED: true, PRODUCER_MAX_RETRIES: 3, PRODUCER_RETRY_DELAY_BASE_MS: 100, TOPICS: {}},
}));

const message = {key: "k", value: "v"};

async function publish(publishWithRetry: (topic: string, message: any) => Promise<void>) {
    const pending = publishWithRetry("topic", message);
    const settled = pending.then(() => "ok", (error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(1_000);
    return await settled;
}

describe("publishWithRetry", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.resetModules();
        send.mockReset();
        env.connected = true;
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("succeeds after a failed attempt", async () => {
        send.mockRejectedValueOnce(new Error("leader not available")).mockResolvedValue(undefined);
        const {publishWithRetry} = await import("../kafkaProducer");

        expect(await publish(publishWithRetry)).toBe("ok");
        expect(send).toHaveBeenCalledTimes(2);
        expect(send).toHaveBeenCalledWith({topic: "topic", messages: [message]});
    });

    it("gives up after the configured number of attempts", async () => {
        send.mockRejectedValue(new Error("broker down"));
        const {publishWithRetry} = await import("../kafkaProducer");

        expect(await publish(publishWithRetry)).toBe("broker down");
        expect(send).toHaveBeenCalledTimes(3);
    });

    it("counts every failed attempt on the breaker and stops retrying once it opens", async () => {
        send.mockRejectedValue(new Error("broker down"));
        const {publishWithRetry} = await import("../kafkaProducer");

        await publish(publishWithRetry);
        // Attempts 4 and 5 reach the 5-failure threshold; the third retry is skipped.
        await publish(publishWithRetry);
        expect(send).toHaveBeenCalledTimes(5);

        expect(await publish(publishWithRetry)).toBe("Circuit breaker Kafka is OPEN");
        expect(send).toHaveBeenCalledTimes(5);
    });
});

describe("publishEvent", () => {
    const event = {eventType: "test_event", timestamp: Date.UTC(2026, 9, 22)};

    beforeEach(() => {
        vi.useFakeTimers();
        vi.resetModules();
        send.mockReset();
        env.connected = true;
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    async function publishEvent(topic: string | undefined): Promise<boolean> {
        const kafkaProducer = await import("../kafkaProducer");
        const pending = kafkaProducer.publishEvent(topic, "key", event);
        await vi.advanceTimersByTimeAsync(1_000);
        return await pending;
    }

    it("sends the event with its type and timestamp as headers", async () => {
        send.mockResolvedValue(undefined);

        expect(await publishEvent("topic")).toBe(true);
        expect(send).toHaveBeenCalledWith({
            topic: "topic",
            messages: [{
                key: "key",
                value: JSON.stringify(event),
                headers: {"event-type": "test_event", "timestamp": "2026-10-22T00:00:00.000Z"},
            }],
        });
    });

    it("reports false instead of throwing when every attempt fails", async () => {
        send.mockRejectedValue(new Error("broker down"));

        expect(await publishEvent("topic")).toBe(false);
    });

    it("reports false without sending when Kafka is disconnected or the topic is missing", async () => {
        expect(await publishEvent(undefined)).toBe(false);
        env.connected = false;
        expect(await publishEvent("topic")).toBe(false);
        expect(send).not.toHaveBeenCalled();
    });
});
