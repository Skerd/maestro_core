import {randomUUID} from "crypto";
import CronLock from "@coreModule/database/schemas/cronLock/cronLock";
import {isRedisConnected, redisReleaseLock, redisTryAcquireOrRenewLock} from "@coreModule/connections/connectToRedis";
import {CRON} from "@coreModule/environment";
import {getLogger} from "@coreModule/loggers/serverLog";

const logger = getLogger("cron_lock");

export type CronLockHandle = {
    key: string;
    token: string;
    ttlMs: number;
    /** Picked at acquire time; renew and release go to the same store. */
    store: "redis" | "mongo";
};

/** Redis lock TTLs are whole seconds; round up so a lock never lives shorter than asked. */
function toTtlSeconds(ttlMs: number): number {
    return Math.max(1, Math.ceil(ttlMs / 1000));
}

/*
 * While Redis is connected it is the only lock store: a refusal from Redis means
 * another instance holds the lock, and falling back to Mongo then would let
 * both instances run. Mongo locks are used only when Redis is unreachable.
 */
export async function acquireCronLock(name: string, ttlMs: number): Promise<CronLockHandle | null> {
    const handle: CronLockHandle = {
        key: `cron:lock:${name}`,
        token: randomUUID(),
        ttlMs,
        store: isRedisConnected() ? "redis" : "mongo",
    };
    if (handle.store === "redis") {
        const acquired = await redisTryAcquireOrRenewLock(handle.key, handle.token, toTtlSeconds(ttlMs));
        return acquired ? handle : null;
    }

    const now = new Date();
    await CronLock.deleteMany({key: handle.key, expiresAt: {$lte: now}});
    try {
        await CronLock.create({
            key: handle.key,
            owner: CRON.SERVER_ID,
            token: handle.token,
            expiresAt: new Date(now.getTime() + ttlMs),
            heartbeatAt: now,
        });
        return handle;
    } catch (e: unknown) {
        if ((e as {code?: number}).code === 11000) {
            return null;
        }
        throw e;
    }
}

/** Extends the lock. False means it is lost: it expired and someone else took it, or the store is down. */
export async function renewCronLock(handle: CronLockHandle): Promise<boolean> {
    if (handle.store === "redis") {
        return redisTryAcquireOrRenewLock(handle.key, handle.token, toTtlSeconds(handle.ttlMs));
    }
    const now = new Date();
    const result = await CronLock.updateOne(
        {key: handle.key, token: handle.token},
        {$set: {heartbeatAt: now, expiresAt: new Date(now.getTime() + handle.ttlMs)}},
    );
    return result.matchedCount === 1;
}

export async function releaseCronLock(handle: CronLockHandle): Promise<void> {
    if (handle.store === "redis") {
        await redisReleaseLock(handle.key, handle.token);
        return;
    }
    await CronLock.deleteOne({key: handle.key, token: handle.token});
}

/** Renews `handle` every third of its TTL until the returned function is called. */
export function keepCronLockAlive(handle: CronLockHandle): () => void {
    const timer = setInterval(() => {
        renewCronLock(handle)
            .then((renewed) => {
                if (!renewed) {
                    logger.err(`Lost cron lock ${handle.key}`);
                }
            })
            .catch((e: unknown) => {
                logger.err(`Cron lock renew failed for ${handle.key}: ${e instanceof Error ? e.message : String(e)}`);
            });
    }, Math.max(Math.floor(handle.ttlMs / 3), 1_000));
    return () => clearInterval(timer);
}
