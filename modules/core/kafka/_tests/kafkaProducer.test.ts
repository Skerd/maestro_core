import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

const send = vi.fn();

vi.mock("@coreModule/connections/connectToKafka", () => ({
    getProducerInstance: () => ({send}),
    isKafkaConnected: () => true,
}));
vi.mock("@coreModule/environment", () => ({
    KAFKA: {ENABLED: true, PRODUCER_MAX_RETRIES: 3, PRODUCER_RETRY_DELAY_BASE_MS: 100, TOPICS: {}},
}));
vi.mock("@coreModule/utilities/serviceMetrics/serviceCounters", () => ({
    kafkaCounter: {recordSuccess: vi.fn(), recordFailure: vi.fn()},
}));

const message = {key: "k", value: "v"};

async function publish(publishWithRetry: (topic: string, message: unknown) => Promise<void>) {
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
