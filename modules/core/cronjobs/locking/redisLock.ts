import {randomUUID} from "crypto";
import {getRedisClient, isRedisConnected, redisDel} from "@coreModule/connections/connectToRedis";
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

export async function acquireRedisLock(key: string, ttlMs: number = CRON.LOCK_TTL_MS): Promise<RedisLockHandle | null> {
    if (!isRedisConnected()) return null;
    const client = getRedisClient();
    const token = randomUUID();
    const fullKey = `cron:lock:${key}`;
    const ok = await client.set(fullKey, token, {NX: true, PX: ttlMs});
    if (ok !== "OK") return null;

    const handle: RedisLockHandle = {key: fullKey, token};
    const renewMs = Math.max(Math.floor(ttlMs / 3), 1_000);
    handle.renewTimer = setInterval(() => {
        void (async () => {
            try {
                const current = await client.get(fullKey);
                if (current === token) {
                    await client.pExpire(fullKey, ttlMs);
                }
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                logger.err(`Lock renew failed for ${fullKey}: ${msg}`);
            }
        })();
    }, renewMs);

    return handle;
}

export async function renewRedisLock(handle: RedisLockHandle, ttlMs: number = CRON.LOCK_TTL_MS): Promise<boolean> {
    if (!isRedisConnected()) return false;
    const client = getRedisClient();
    const current = await client.get(handle.key);
    if (current !== handle.token) return false;
    await client.pExpire(handle.key, ttlMs);
    return true;
}

export async function releaseRedisLock(handle: RedisLockHandle): Promise<void> {
    if (handle.renewTimer) {
        clearInterval(handle.renewTimer);
        handle.renewTimer = undefined;
    }
    if (!isRedisConnected()) return;
    const client = getRedisClient();
    const current = await client.get(handle.key);
    if (current === handle.token) {
        await redisDel(handle.key);
    }
}

export async function acquireLeaderLock(serverId: string): Promise<RedisLockHandle | null> {
    return acquireRedisLock("leader", CRON.LEADER_LOCK_TTL_MS);
}
