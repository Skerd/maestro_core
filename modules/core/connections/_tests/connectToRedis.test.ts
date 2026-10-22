import {EventEmitter} from "events";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

const state = vi.hoisted(() => ({clients: [] as any[], connectFailures: 0}));

class FakeRedisClient extends EventEmitter {
    isReady = false;
    connect = vi.fn(async () => {
        if (state.connectFailures > 0) {
            state.connectFailures--;
            throw new Error("ECONNREFUSED");
        }
        this.isReady = true;
        this.emit("ready");
    });
    quit = vi.fn(async () => {
        this.isReady = false;
        this.emit("end");
    });
    get = vi.fn();
    setEx = vi.fn();
    del = vi.fn();
    mGet = vi.fn();
    eval = vi.fn();
    ping = vi.fn();
}


vi.mock("redis", () => ({
    createClient: () => {
        const client = new FakeRedisClient();
        state.clients.push(client);
        return client;
    },
}));
vi.mock("@coreModule/environment", () => ({
    REDIS: {
        ROOT_NODES: ["localhost:6379"],
        USERNAME: "",
        PASSWORD: "",
        DATABASE: 0,
        CONNECT_TIMEOUT: 1000,
        CONNECTION_TIMER: 1000,
    },
}));
vi.mock("@coreModule/utilities/uptime/uptimeKeeper", () => ({
    uptimeKeeper: {markStart: vi.fn(async () => {}), getLastStart: vi.fn(() => 0)},
}));
vi.mock("@coreModule/utilities/serviceMetrics/serviceCounters", () => ({
    redisCounter: {recordSuccess: vi.fn(), recordFailure: vi.fn(), getStats: vi.fn(() => ({}))},
}));

type RedisModule = typeof import("../connectToRedis");

async function connected(): Promise<{redis: RedisModule; client: FakeRedisClient}> {
    const redis = await import("../connectToRedis");
    await redis.connectToRedis();
    await vi.advanceTimersByTimeAsync(0);
    return {redis, client: state.clients[state.clients.length - 1]};
}

describe("connectToRedis", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.resetModules();
        state.clients.length = 0;
        state.connectFailures = 0;
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("returns safe fallbacks before Redis is connected", async () => {
        const redis = await import("../connectToRedis");

        expect(redis.isRedisConnected()).toBe(false);
        expect(await redis.redisGet("k")).toBeNull();
        expect(await redis.redisMGet(["a", "b"])).toEqual([null, null]);
        expect(await redis.redisIncrWithExpiry("k", 60)).toBeNull();
        expect(await redis.redisTryAcquireOrRenewLock("lock", "me", 30)).toBe(false);
    });

    it("keeps retrying the first connection until Redis answers", async () => {
        state.connectFailures = 1;
        const redis = await import("../connectToRedis");
        await redis.connectToRedis();
        const client: FakeRedisClient = state.clients[0];
        await vi.advanceTimersByTimeAsync(0);
        expect(redis.isRedisConnected()).toBe(false);

        await vi.advanceTimersByTimeAsync(1000);
        expect(client.connect).toHaveBeenCalledTimes(2);
        expect(redis.isRedisConnected()).toBe(true);
    });

    it("reconnects after the connection ends", async () => {
        const {redis, client} = await connected();
        client.isReady = false;
        client.emit("end");
        expect(redis.isRedisConnected()).toBe(false);

        await vi.advanceTimersByTimeAsync(1000);
        expect(client.connect).toHaveBeenCalledTimes(2);
        expect(redis.isRedisConnected()).toBe(true);
    });

    it("does not reconnect after disconnectFromRedis", async () => {
        const {redis, client} = await connected();
        await redis.disconnectFromRedis();
        await vi.advanceTimersByTimeAsync(5000);

        expect(client.quit).toHaveBeenCalledTimes(1);
        expect(client.connect).toHaveBeenCalledTimes(1);
        expect(redis.isRedisConnected()).toBe(false);
    });

    it("returns the value from redisGet and null when the command fails", async () => {
        const {redis, client} = await connected();
        client.get.mockResolvedValueOnce("v").mockRejectedValueOnce(new Error("boom"));

        expect(await redis.redisGet("k")).toBe("v");
        expect(await redis.redisGet("k")).toBeNull();
    });

    it("opens the circuit after repeated failures and then stops calling Redis", async () => {
        const {redis, client} = await connected();
        client.get.mockRejectedValue(new Error("boom"));

        for (let i = 0; i < 6; i++) {
            expect(await redis.redisGet("k")).toBeNull();
        }
        expect(client.get).toHaveBeenCalledTimes(5);
    });

    it("counts a hung command as a failure instead of waiting forever", async () => {
        const {redis, client} = await connected();
        client.get.mockReturnValue(new Promise(() => {}));

        const pending = redis.redisGet("k");
        await vi.advanceTimersByTimeAsync(5000);
        expect(await pending).toBeNull();
    });

    it("increments with expiry in one script and reports count and ttl", async () => {
        const {redis, client} = await connected();
        client.eval.mockResolvedValue([3, 42]);

        expect(await redis.redisIncrWithExpiry("rate:k", 60)).toEqual({count: 3, ttlSeconds: 42});
        expect(client.eval).toHaveBeenCalledWith(expect.stringContaining("incr"), {keys: ["rate:k"], arguments: ["60"]});
    });

    it("acquires a lock only when the script grants it", async () => {
        const {redis, client} = await connected();
        client.eval.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

        expect(await redis.redisTryAcquireOrRenewLock("lock", "me", 30)).toBe(true);
        expect(await redis.redisTryAcquireOrRenewLock("lock", "me", 30)).toBe(false);
        expect(client.eval).toHaveBeenLastCalledWith(expect.any(String), {keys: ["lock"], arguments: ["me", "30"]});
    });
});
