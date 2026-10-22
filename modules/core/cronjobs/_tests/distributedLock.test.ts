import {beforeEach, describe, expect, it, vi} from "vitest";

const redis = vi.hoisted(() => ({
    connected: vi.fn(),
    tryAcquireOrRenew: vi.fn(),
    release: vi.fn(),
}));
const mongo = vi.hoisted(() => ({
    create: vi.fn(),
    deleteMany: vi.fn(),
    updateOne: vi.fn(),
    deleteOne: vi.fn(),
}));

vi.mock("@coreModule/connections/connectToRedis", () => ({
    isRedisConnected: () => redis.connected(),
    redisTryAcquireOrRenewLock: (...args: unknown[]) => redis.tryAcquireOrRenew(...args),
    redisReleaseLock: (...args: unknown[]) => redis.release(...args),
}));
vi.mock("@coreModule/database/schemas/cronLock/cronLock", () => ({default: mongo}));
vi.mock("@coreModule/environment", () => ({CRON: {SERVER_ID: "cron-1"}}));

import {acquireCronLock, releaseCronLock, renewCronLock} from "../locking/distributedLock";

describe("distributedLock", () => {
    beforeEach(() => {
        for (const fn of [...Object.values(redis), ...Object.values(mongo)]) fn.mockReset();
        mongo.deleteMany.mockResolvedValue({deletedCount: 0});
        mongo.create.mockResolvedValue({});
    });

    it("uses the Redis lock while Redis is connected", async () => {
        redis.connected.mockReturnValue(true);
        redis.tryAcquireOrRenew.mockResolvedValue(true);

        const handle = await acquireCronLock("job-1", 2_500);

        expect(handle).toMatchObject({key: "cron:lock:job-1", store: "redis", ttlMs: 2_500});
        expect(redis.tryAcquireOrRenew).toHaveBeenCalledWith("cron:lock:job-1", handle?.token, 3);
        expect(mongo.create).not.toHaveBeenCalled();
    });

    it("does not fall back to Mongo when another instance holds the Redis lock", async () => {
        redis.connected.mockReturnValue(true);
        redis.tryAcquireOrRenew.mockResolvedValue(false);

        expect(await acquireCronLock("job-1", 1_000)).toBeNull();
        expect(mongo.create).not.toHaveBeenCalled();
    });

    it("falls back to Mongo only when Redis is unreachable", async () => {
        redis.connected.mockReturnValue(false);

        const handle = await acquireCronLock("leader", 15_000);

        expect(handle).toMatchObject({key: "cron:lock:leader", store: "mongo"});
        expect(mongo.create).toHaveBeenCalledWith(expect.objectContaining({key: "cron:lock:leader", owner: "cron-1"}));
        expect(redis.tryAcquireOrRenew).not.toHaveBeenCalled();
    });

    it("treats a duplicate Mongo key as a lock held elsewhere", async () => {
        redis.connected.mockReturnValue(false);
        mongo.create.mockRejectedValue(Object.assign(new Error("dup"), {code: 11000}));

        expect(await acquireCronLock("job-1", 1_000)).toBeNull();
    });

    it("renews and releases in the store the lock was taken in", async () => {
        redis.connected.mockReturnValue(false);
        const handle = await acquireCronLock("job-1", 1_000);
        redis.connected.mockReturnValue(true);

        mongo.updateOne.mockResolvedValue({matchedCount: 0});
        expect(await renewCronLock(handle!)).toBe(false);
        await releaseCronLock(handle!);

        expect(mongo.deleteOne).toHaveBeenCalledWith({key: "cron:lock:job-1", token: handle!.token});
        expect(redis.tryAcquireOrRenew).not.toHaveBeenCalled();
        expect(redis.release).not.toHaveBeenCalled();
    });
});
