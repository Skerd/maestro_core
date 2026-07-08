/**
 * Uptime Keeper
 *
 * Tracks when each service successfully connected/started in the current
 * process and persists that state in the `ServiceUptime` ledger so the
 * admin "uptime" badge survives restarts.
 *
 * Lifecycle per service:
 *  1. `markStart(service)` — called by each `connectTo*` module after a successful connect.
 *     Inserts a row in MongoDB and records `startedAt` in process memory.
 *  2. `markHeartbeat(service)` — called periodically (every 30s by `start()`) to refresh `lastSeenAt`.
 *  3. `markStop(service)` — called on graceful shutdown to write `stoppedAt`.
 *
 * Health getters call `getLastStart(service)` for the value to expose in the
 * `ServerHealthFormResponseType.services.<svc>.lastStart` field. The value is
 * resolved synchronously from the in-memory cache; the cache is hydrated from
 * Mongo on `start()` so a process that restarts quickly preserves continuity.
 *
 * @module utilities/core/uptime/uptimeKeeper
 */

import {ObjectId} from "mongodb";
import os from "os";
import {getLogger} from "@coreModule/loggers/serverLog";
import ServiceUptime, {
    IServiceUptime,
    ServiceUptimeName
} from "@coreModule/database/schemas/performance/serviceUptime/serviceUptime";

export type {ServiceUptimeName};

const HEARTBEAT_INTERVAL_MS = 30_000;
const logger = getLogger("uptime_keeper");

class UptimeKeeper {
    /** Last known startedAt timestamp per service (ms). 0 means not started yet in this process. */
    private readonly lastStartByService = new Map<ServiceUptimeName, number>();
    /** Last known _id per service for heartbeat updates. */
    private readonly rowIdByService = new Map<ServiceUptimeName, ObjectId>();
    private heartbeatTimer: NodeJS.Timeout | null = null;

    /**
     * Marks a service as just started. Inserts a row and updates the in-memory cache.
     * Safe to call multiple times — every call creates a new "session" row.
     */
    async markStart(service: ServiceUptimeName, version: string = ""): Promise<void> {
        const now = new Date();
        try {
            const doc: Partial<IServiceUptime> = {
                service,
                serverName: global.ServerName || "unknown",
                processId: process.pid,
                host: os.hostname(),
                version,
                startedAt: now,
                lastSeenAt: now
            };
            const created = await ServiceUptime.create(doc);
            this.lastStartByService.set(service, now.getTime());
            this.rowIdByService.set(service, created._id);
            logger.debug(`[uptime] markStart ${service} at ${now.toISOString()}`);
        }
        catch (e: any) {
            // Persistence failure is non-fatal: keep an in-memory record so the
            // current process still reports uptime; persistence will recover on the
            // next call once Mongo is back.
            this.lastStartByService.set(service, now.getTime());
            logger.warn(`[uptime] markStart persistence failed for ${service}: ${e?.message}`); 
        }
    }

    /**
     * Refreshes `lastSeenAt` for the active row of the given service. No-op when
     * `markStart` has not been called yet in this process.
     */
    async markHeartbeat(service: ServiceUptimeName): Promise<void> {
        const id = this.rowIdByService.get(service);
        if (!id) return;
        try {
            await ServiceUptime.updateOne({ _id: id }, { $set: { lastSeenAt: new Date() } });
        }
        catch {
            // Heartbeats are best-effort; never log noisily on failure.
        }
    }

    /**
     * Marks the active row as stopped. Used during graceful shutdown.
     */
    async markStop(service: ServiceUptimeName): Promise<void> {
        const id = this.rowIdByService.get(service);
        if (!id) return;
        try {
            await ServiceUptime.updateOne({ _id: id }, { $set: { stoppedAt: new Date() } });
        }
        catch (e: any) {
            logger.warn(`[uptime] markStop persistence failed for ${service}: ${e?.message}`);
        }
        this.rowIdByService.delete(service);
    }

    /**
     * Returns the unix-ms timestamp of the latest known start for `service`.
     * Falls back to the most recent persisted `startedAt` if the in-memory
     * value is missing (e.g. process started after a Mongo connect retry).
     */
    getLastStart(service: ServiceUptimeName): number {
        return this.lastStartByService.get(service) ?? 0;
    }

    /**
     * Hydrates the in-memory cache from Mongo. Should be called once per process
     * after Mongo connects but before health getters serve their first request.
     *
     * Selects the most recent active row per service (no `stoppedAt`) for the
     * current host so multi-instance deployments don't trample each other.
     */
    async hydrate(): Promise<void> {
        try {
            const host = os.hostname();
            const rows = await ServiceUptime.aggregate<IServiceUptime>([
                { $match: { host, stoppedAt: { $exists: false } } },
                { $sort: { startedAt: -1 } },
                { $group: {
                    _id: "$service",
                    doc: { $first: "$$ROOT" }
                }},
                { $replaceRoot: { newRoot: "$doc" } }
            ]).exec();
            for (const row of rows) {
                this.lastStartByService.set(row.service as ServiceUptimeName, new Date(row.startedAt).getTime());
                this.rowIdByService.set(row.service as ServiceUptimeName, row._id as ObjectId);
            }
        }
        catch (e: any) {
            logger.warn(`[uptime] hydrate failed: ${e?.message}`);
        }
    }

    /**
     * Starts the periodic heartbeat that refreshes `lastSeenAt` for every
     * active service this process has registered. Idempotent.
     */
    start(): void {
        if (this.heartbeatTimer) return;
        this.heartbeatTimer = setInterval(async () => {
            for (const service of this.rowIdByService.keys()) {
                await this.markHeartbeat(service);
            }
        }, HEARTBEAT_INTERVAL_MS);
    }

    stop(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }
}

export const uptimeKeeper = new UptimeKeeper();
