import {randomUUID} from "crypto";
import {redisReleaseLock, redisTryAcquireOrRenewLock} from "@coreModule/connections/connectToRedis";
import {CRON} from "@coreModule/environment";
import {getLogger} from "@coreModule/loggers/serverLog";
// Heartbeat lives with counters in cronSchedulerHealth; re-exported below for
// callers that historically imported it from this lock module.
export {publishSchedulerHeartbeat} from "@coreModule/cronjobs/health/cronSchedulerHealth";

const logger = getLogger("cron_lock_redis");

export type RedisLockHandle = {
    key: string;
    token: string;
    renewTimer?: NodeJS.Timeout;
};

/** Redis lock TTLs are whole seconds; round up so a lock never lives shorter than asked. */
function toTtlSeconds(ttlMs: number): number {
    return Math.max(1, Math.ceil(ttlMs / 1000));
}

/**
 * Takes the lock when nobody holds it. A fresh token per call means the
 * acquire-or-renew primitive can only succeed on an unset key here.
 * Returns null when the lock is held elsewhere or Redis is unavailable.
 */
export async function acquireRedisLock(key: string, ttlMs: number = CRON.LOCK_TTL_MS): Promise<RedisLockHandle | null> {
    const token = randomUUID();
    const fullKey = `cron:lock:${key}`;
    const acquired = await redisTryAcquireOrRenewLock(fullKey, token, toTtlSeconds(ttlMs));
    if (!acquired) return null;

    const handle: RedisLockHandle = {key: fullKey, token};
    const renewMs = Math.max(Math.floor(ttlMs / 3), 1_000);
    handle.renewTimer = setInterval(() => {
        void renewRedisLock(handle, ttlMs).then((renewed) => {
            if (!renewed) {
                logger.err(`Lock renew failed for ${fullKey}`);
            }
        });
    }, renewMs);

    return handle;
}

/**
 * Extends the lock while this handle owns it. If the lock had already expired
 * and nobody took it, it is re-taken; false means another owner has it (or
 * Redis is unavailable).
 */
export async function renewRedisLock(handle: RedisLockHandle, ttlMs: number = CRON.LOCK_TTL_MS): Promise<boolean> {
    return redisTryAcquireOrRenewLock(handle.key, handle.token, toTtlSeconds(ttlMs));
}

export async function releaseRedisLock(handle: RedisLockHandle): Promise<void> {
    if (handle.renewTimer) {
        clearInterval(handle.renewTimer);
        handle.renewTimer = undefined;
    }
    await redisReleaseLock(handle.key, handle.token);
}

export async function acquireLeaderLock(): Promise<RedisLockHandle | null> {
    return acquireRedisLock("leader", CRON.LEADER_LOCK_TTL_MS);
}
