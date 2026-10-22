import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

const state = vi.hoisted(() => ({
    env: {ENABLED: true},
    producers: [] as any[],
    consumers: [] as any[],
    connectFailures: 0,
    disconnectOrder: [] as string[],
}));

function fakeProducer() {
    const listeners = new Map<string, () => void>();
    const producer = {
        on: vi.fn((event: string, listener: () => void) => {
            listeners.set(event, listener);
        }),
        emit: (event: string) => listeners.get(event)?.(),
        connect: vi.fn(async () => {
            if (state.connectFailures > 0) {
                state.connectFailures--;
                throw new Error("broker down");
            }
        }),
        disconnect: vi.fn(async () => {
            state.disconnectOrder.push("producer");
            producer.emit("producer.disconnect");
        }),
        send: vi.fn(),
    };
    return producer;
}

vi.mock("kafkajs", () => ({
    Partitioners: {DefaultPartitioner: vi.fn()},
    Kafka: class {
        producer() {
            const producer = fakeProducer();
            state.producers.push(producer);
            return producer;
        }
        consumer() {
            const consumer = {disconnect: vi.fn(async () => {
                state.disconnectOrder.push("consumer");
            })};
            state.consumers.push(consumer);
            return consumer;
        }
        admin() {
            return {
                connect: vi.fn(async () => {}),
                disconnect: vi.fn(async () => {}),
                describeCluster: vi.fn(async () => ({brokers: [{host: "b", port: 9092}], clusterId: "c1"})),
                listTopics: vi.fn(async () => ["t1"]),
                createTopics: vi.fn(async () => true),
            };
        }
    },
}));
vi.mock("@coreModule/environment", () => ({
    KAFKA: new Proxy({}, {
        get: (_target, key: string) => ({
            CLIENT_ID: "test",
            BROKERS: ["b:9092"],
            SECURITY_PROTOCOL: "PLAINTEXT",
            CONNECTION_TIMER: 1000,
            ...state.env,
        } as Record<string, unknown>)[key],
    }),
}));
vi.mock("@coreModule/utilities/uptime/uptimeKeeper", () => ({
    uptimeKeeper: {markStart: vi.fn(async () => {}), getLastStart: vi.fn(() => 0)},
}));

async function load() {
    return await import("../connectToKafka");
}

describe("connectToKafka", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.resetModules();
        state.env = {ENABLED: true};
        state.producers.length = 0;
        state.consumers.length = 0;
        state.connectFailures = 0;
        state.disconnectOrder.length = 0;
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("does nothing when Kafka is disabled", async () => {
        state.env = {ENABLED: false};
        const kafka = await load();
        await kafka.connectToKafka();

        expect(kafka.getProducerInstance()).toBeNull();
        expect(kafka.isKafkaConnected()).toBe(false);
        expect(state.producers).toHaveLength(0);
    });

    it("keeps retrying the producer connection until a broker answers", async () => {
        state.connectFailures = 2;
        const kafka = await load();
        await kafka.connectToKafka();
        await vi.advanceTimersByTimeAsync(0);
        expect(kafka.isKafkaConnected()).toBe(false);

        await vi.advanceTimersByTimeAsync(2000);
        expect(state.producers[0].connect).toHaveBeenCalledTimes(3);
        expect(kafka.isKafkaConnected()).toBe(true);
    });

    it("reconnects when the producer reports a disconnect", async () => {
        const kafka = await load();
        await kafka.connectToKafka();
        await vi.advanceTimersByTimeAsync(0);
        const producer = state.producers[0];

        producer.emit("producer.disconnect");
        expect(kafka.isKafkaConnected()).toBe(false);
        await vi.advanceTimersByTimeAsync(1000);

        expect(producer.connect).toHaveBeenCalledTimes(2);
        expect(kafka.isKafkaConnected()).toBe(true);
    });

    it("keeps the producer when a single request times out", async () => {
        const kafka = await load();
        await kafka.connectToKafka();
        await vi.advanceTimersByTimeAsync(0);
        const producer = state.producers[0];

        producer.emit("producer.network.request_timeout");
        await vi.advanceTimersByTimeAsync(1000);

        expect(kafka.isKafkaConnected()).toBe(true);
        expect(producer.disconnect).not.toHaveBeenCalled();
        expect(producer.connect).toHaveBeenCalledTimes(1);
    });

    it("disconnects every consumer, then the producer, without reconnecting", async () => {
        const kafka = await load();
        await kafka.connectToKafka();
        await vi.advanceTimersByTimeAsync(0);
        kafka.getConsumerInstance("group-a");
        kafka.getConsumerInstance("group-b");
        const producer = state.producers[0];

        await kafka.disconnectFromKafka();
        await vi.advanceTimersByTimeAsync(5000);

        expect(producer.disconnect).toHaveBeenCalledTimes(1);
        expect(producer.connect).toHaveBeenCalledTimes(1);
        expect(state.producers).toHaveLength(1);
        expect(state.consumers.every((c) => c.disconnect.mock.calls.length === 1)).toBe(true);
        expect(state.disconnectOrder).toEqual(["consumer", "consumer", "producer"]);
        expect(kafka.isKafkaConnected()).toBe(false);
    });

    it("reports cluster metadata from the probe", async () => {
        const kafka = await load();
        await kafka.connectToKafka();
        await vi.advanceTimersByTimeAsync(1000);

        expect(await kafka.getKafkaHealth()).toMatchObject({
            connected: true,
            brokersOnline: ["b:9092"],
            topics: ["t1"],
            clusterId: "c1",
        });
    });
});
