import {CRON} from "@coreModule/environment";
import {
    acquireLeaderLock as acquireRedisLeader,
    acquireRedisLock,
    publishSchedulerHeartbeat,
    releaseRedisLock,
    renewRedisLock,
    type RedisLockHandle,
} from "@coreModule/cronjobs/locking/redisLock";
import {
    acquireMongoLock,
    releaseMongoLock,
    type MongoLockHandle,
} from "@coreModule/cronjobs/locking/mongoLock";

export type DistributedLockHandle = {
    redis?: RedisLockHandle;
    mongo?: MongoLockHandle;
};

export async function acquireJobLock(jobId: string, executionId?: string): Promise<DistributedLockHandle | null> {
    const key = executionId ? `${jobId}:${executionId}` : jobId;
    const redis = await acquireRedisLock(key);
    if (redis) return {redis};
    const mongo = await acquireMongoLock(key);
    if (mongo) return {mongo};
    return null;
}

export async function releaseJobLock(handle: DistributedLockHandle): Promise<void> {
    if (handle.redis) await releaseRedisLock(handle.redis);
    if (handle.mongo) await releaseMongoLock(handle.mongo);
}

export async function tryAcquireSchedulerLeader(): Promise<DistributedLockHandle | null> {
    const redis = await acquireRedisLeader();
    if (redis) return {redis};
    const mongo = await acquireMongoLock("leader", CRON.LEADER_LOCK_TTL_MS, CRON.SERVER_ID);
    return mongo ? {mongo} : null;
}

export async function releaseSchedulerLeader(handle: DistributedLockHandle): Promise<void> {
    await releaseJobLock(handle);
}

export {publishSchedulerHeartbeat};
