import {BaseCrudService} from "@coreModule/database/services/baseCrudService";
import CronLock, {ICronLock} from "@coreModule/database/schemas/cronLock/cronLock";

/** The Mongo cron lock store, used only while Redis is unreachable (`cronjobs/locking/distributedLock.ts`). */
class CronLockService extends BaseCrudService<ICronLock, typeof CronLock> {
    constructor() {
        super(CronLock, "CronLock");
    }

    /** Takes lock `key` for `token`, clearing an expired holder first. False while a live holder has it. */
    async tryAcquire(lock: {key: string; owner: string; token: string; ttlMs: number}, now: Date): Promise<boolean> {
        await this.model.deleteMany({key: lock.key, expiresAt: {$lte: now}});
        try {
            await this.model.create({
                key: lock.key,
                owner: lock.owner,
                token: lock.token,
                expiresAt: new Date(now.getTime() + lock.ttlMs),
                heartbeatAt: now,
            });
            return true;
        } catch (e: unknown) {
            // The unique key: another holder took it between the clear and the insert.
            if ((e as {code?: number}).code === 11000) return false;
            throw e;
        }
    }

    /** Extends the lock while `token` still holds it. */
    async renew(key: string, token: string, ttlMs: number, now: Date): Promise<boolean> {
        const result = await this.model.updateOne(
            {key, token},
            {$set: {heartbeatAt: now, expiresAt: new Date(now.getTime() + ttlMs)}},
        );
        return result.matchedCount === 1;
    }

    async release(key: string, token: string): Promise<void> {
        await this.model.deleteOne({key, token});
    }
}

export const cronLockService = new CronLockService();
