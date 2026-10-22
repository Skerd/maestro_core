import {beforeAll, beforeEach, describe, expect, it, vi} from "vitest";

const state = vi.hoisted(() => ({
    topics: [] as string[],
    ends: {} as Record<string, {partition: number; low: string; high: string}[]>,
    committed: {} as Record<string, {partition: number; offset: string}[]>,
    batches: [] as {partition: number; offsets: number[]}[],
    lockFree: true,
}));
const publishWithRetry = vi.fn();
const commitOffsetsIfNecessary = vi.fn();
const pause = vi.fn();
const releaseLock = vi.fn();

function letter(offset: number) {
    return {
        offset: String(offset),
        key: Buffer.from(`key-${offset}`),
        value: Buffer.from(JSON.stringify({originalTopic: "orders", originalOffset: "40", originalMessage: `message-${offset}`})),
    };
}

const consumer = {
    events: {CRASH: "consumer.crash"},
    on: vi.fn(),
    connect: vi.fn(async () => {}),
    subscribe: vi.fn(async () => {}),
    run: vi.fn(async ({eachBatch}: {eachBatch: (payload: any) => Promise<void>}) => {
        void (async () => {
            for (const {partition, offsets} of state.batches) {
                await eachBatch({batch: {partition, messages: offsets.map(letter)}, pause, commitOffsetsIfNecessary})
                    .catch(() => {});
            }
        })();
    }),
};
const admin = {
    listTopics: vi.fn(async () => state.topics),
    fetchTopicOffsets: vi.fn(async (topic: string) => state.ends[topic] || []),
    fetchOffsets: vi.fn(async ({topics}: {topics: string[]}) => [{topic: topics[0], partitions: state.committed[topics[0]] || []}]),
};

vi.mock("@coreModule/connections/connectToKafka", () => ({
    getConsumerInstance: () => consumer,
    releaseConsumerInstance: vi.fn(async () => {}),
    withKafkaAdmin: (work: (a: typeof admin) => Promise<unknown>) => work(admin),
}));
vi.mock("@coreModule/connections/connectToRedis", () => ({
    redisTryAcquireOrRenewLock: async () => state.lockFree,
    redisReleaseLock: (...args: unknown[]) => releaseLock(...args),
}));
vi.mock("@coreModule/kafka/kafkaProducer", () => ({
    publishWithRetry: (...args: unknown[]) => publishWithRetry(...args),
}));
vi.mock("@coreModule/environment", () => ({KAFKA: {PRODUCER_MAX_RETRIES: 3}}));

let getDeadLetterBacklog: typeof import("../deadLetters").getDeadLetterBacklog;
let replayDeadLetters: typeof import("../deadLetters").replayDeadLetters;

describe("dead letters", () => {
    beforeAll(async () => {
        ({getDeadLetterBacklog, replayDeadLetters} = await import("../deadLetters"));
    });
    beforeEach(() => {
        vi.clearAllMocks();
        state.topics = ["orders", "orders_dlq", "emails_dlq", "empty_dlq"];
        state.ends = {
            orders_dlq: [{partition: 0, low: "0", high: "10"}, {partition: 1, low: "5", high: "8"}],
            emails_dlq: [{partition: 0, low: "0", high: "2"}],
            empty_dlq: [{partition: 0, low: "0", high: "4"}],
        };
        // Partition 1 of orders has no committed offset (-1): counting starts at its low mark.
        state.committed = {
            orders_dlq: [{partition: 0, offset: "7"}, {partition: 1, offset: "-1"}],
            empty_dlq: [{partition: 0, offset: "4"}],
        };
        state.batches = [];
        state.lockFree = true;
    });

    it("counts the letters not replayed yet, per original topic", async () => {
        expect(await getDeadLetterBacklog()).toEqual([
            {topic: "emails", pending: 2},
            {topic: "orders", pending: 6},
        ]);
    });

    it("replays up to the end it started from and commits only that far", async () => {
        state.ends = {orders_dlq: [{partition: 0, low: "0", high: "9"}]};
        // Offset 9 was dead-lettered after the replay started.
        state.batches = [{partition: 0, offsets: [7, 8, 9]}];

        expect(await replayDeadLetters("orders")).toBe(2);
        expect(publishWithRetry).toHaveBeenCalledTimes(2);
        expect(publishWithRetry).toHaveBeenCalledWith("orders", {
            key: Buffer.from("key-7"),
            value: "message-7",
            headers: {"replayed-from": "orders_dlq"},
        });
        expect(commitOffsetsIfNecessary).toHaveBeenCalledWith({topics: [{topic: "orders_dlq", partitions: [{partition: 0, offset: "9"}]}]});
        expect(releaseLock).toHaveBeenCalledTimes(1);
    });

    it("lists without sending or committing on a dry run", async () => {
        state.ends = {orders_dlq: [{partition: 0, low: "0", high: "9"}]};
        state.batches = [{partition: 0, offsets: [7, 8]}];
        const onLetter = vi.fn();

        expect(await replayDeadLetters("orders", {dryRun: true, onLetter})).toBe(2);
        expect(onLetter).toHaveBeenCalledTimes(2);
        expect(publishWithRetry).not.toHaveBeenCalled();
        expect(commitOffsetsIfNecessary).not.toHaveBeenCalled();
    });

    it("commits what was resent before a failure, then fails", async () => {
        state.ends = {orders_dlq: [{partition: 0, low: "0", high: "10"}]};
        state.batches = [{partition: 0, offsets: [7, 8, 9]}];
        publishWithRetry.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("broker down"));

        await expect(replayDeadLetters("orders")).rejects.toThrow("broker down");
        expect(commitOffsetsIfNecessary).toHaveBeenCalledWith({topics: [{topic: "orders_dlq", partitions: [{partition: 0, offset: "8"}]}]});
        expect(pause).toHaveBeenCalledTimes(1);
        expect(releaseLock).toHaveBeenCalledTimes(1);
    });

    it("does nothing when another replay of the topic holds the lock", async () => {
        state.lockFree = false;

        expect(await replayDeadLetters("orders")).toBeNull();
        expect(consumer.connect).not.toHaveBeenCalled();
        expect(releaseLock).not.toHaveBeenCalled();
    });

    it("skips the consumer when nothing is pending", async () => {
        expect(await replayDeadLetters("empty")).toBe(0);
        expect(consumer.connect).not.toHaveBeenCalled();
    });
});
