import {randomUUID} from "crypto";
import CronLock from "@coreModule/database/schemas/cronLock/cronLock";
import {CRON} from "@coreModule/environment";
import {getLogger} from "@coreModule/loggers/serverLog";

const logger = getLogger("cron_lock_mongo");

export type MongoLockHandle = {
    key: string;
    token: string;
    owner: string;
    renewTimer?: NodeJS.Timeout;
};

export async function acquireMongoLock(
    key: string,
    ttlMs: number = CRON.LOCK_TTL_MS,
    owner: string = CRON.SERVER_ID,
): Promise<MongoLockHandle | null> {
    const token = randomUUID();
    const fullKey = `cron:lock:${key}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);

    await CronLock.deleteMany({key: fullKey, expiresAt: {$lte: now}});

    try {
        await CronLock.create({
            key: fullKey,
            owner,
            token,
            expiresAt,
            heartbeatAt: now,
        });
    } catch (e: unknown) {
        const code = (e as {code?: number})?.code;
        if (code === 11000) {
            return null;
        }
        throw e;
    }

    const handle: MongoLockHandle = {key: fullKey, token, owner};
    const renewMs = Math.max(Math.floor(ttlMs / 3), 1_000);
    handle.renewTimer = setInterval(() => {
        void CronLock.updateOne(
            {key: fullKey, token},
            {$set: {heartbeatAt: new Date(), expiresAt: new Date(Date.now() + ttlMs)}},
        ).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            logger.err(`Mongo lock renew failed: ${msg}`);
        });
    }, renewMs);

    return handle;
}

export async function releaseMongoLock(handle: MongoLockHandle): Promise<void> {
    if (handle.renewTimer) {
        clearInterval(handle.renewTimer);
    }
    await CronLock.deleteOne({key: handle.key, token: handle.token});
}

export async function pruneStaleMongoLocks(): Promise<number> {
    const result = await CronLock.deleteMany({expiresAt: {$lte: new Date()}});
    return result.deletedCount ?? 0;
}
