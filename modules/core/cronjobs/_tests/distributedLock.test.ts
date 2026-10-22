import {beforeEach, describe, expect, it, vi} from "vitest";

const redisConnected = vi.fn();
const acquireRedisLock = vi.fn();
const acquireLeaderLock = vi.fn();
const acquireMongoLock = vi.fn();

vi.mock("@coreModule/connections/connectToRedis", () => ({isRedisConnected: () => redisConnected()}));
vi.mock("@coreModule/environment", () => ({CRON: {LEADER_LOCK_TTL_MS: 15000, SERVER_ID: "cron-1"}}));
vi.mock("@coreModule/cronjobs/locking/redisLock", () => ({
    acquireRedisLock: (key: string) => acquireRedisLock(key),
    acquireLeaderLock: () => acquireLeaderLock(),
    releaseRedisLock: vi.fn(),
    renewRedisLock: vi.fn(),
    publishSchedulerHeartbeat: vi.fn(),
}));
vi.mock("@coreModule/cronjobs/locking/mongoLock", () => ({
    acquireMongoLock: (...args: unknown[]) => acquireMongoLock(...args),
    releaseMongoLock: vi.fn(),
}));

import {acquireJobLock, tryAcquireSchedulerLeader} from "../locking/distributedLock";

describe("distributedLock", () => {
    beforeEach(() => {
        for (const fn of [redisConnected, acquireRedisLock, acquireLeaderLock, acquireMongoLock]) fn.mockReset();
        acquireMongoLock.mockResolvedValue({key: "mongo"});
    });

    it("uses the Redis lock while Redis is connected", async () => {
        redisConnected.mockReturnValue(true);
        acquireRedisLock.mockResolvedValue({key: "cron:lock:job-1", token: "t"});

        expect(await acquireJobLock("job-1")).toEqual({redis: {key: "cron:lock:job-1", token: "t"}});
        expect(acquireMongoLock).not.toHaveBeenCalled();
    });

    it("does not fall back to Mongo when another instance holds the Redis lock", async () => {
        redisConnected.mockReturnValue(true);
        acquireRedisLock.mockResolvedValue(null);

        expect(await acquireJobLock("job-1")).toBeNull();
        expect(acquireMongoLock).not.toHaveBeenCalled();
    });

    it("falls back to Mongo only when Redis is unreachable", async () => {
        redisConnected.mockReturnValue(false);

        expect(await acquireJobLock("job-1", "exec-1")).toEqual({mongo: {key: "mongo"}});
        expect(acquireRedisLock).not.toHaveBeenCalled();
        expect(acquireMongoLock).toHaveBeenCalledWith("job-1:exec-1");
    });

    it("applies the same rule to scheduler leadership", async () => {
        redisConnected.mockReturnValue(true);
        acquireLeaderLock.mockResolvedValue(null);
        expect(await tryAcquireSchedulerLeader()).toBeNull();

        redisConnected.mockReturnValue(false);
        expect(await tryAcquireSchedulerLeader()).toEqual({mongo: {key: "mongo"}});
        expect(acquireMongoLock).toHaveBeenCalledTimes(1);
    });
});
