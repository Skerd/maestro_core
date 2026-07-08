import {Schema} from "mongoose";

/**
 * Indexes for the ServiceUptime ledger.
 *
 *  - `{service, startedAt: -1}` — fast "latest start per service" lookups for health responses.
 *  - `{service, stoppedAt: 1, lastSeenAt: -1}` — list active rows per service.
 *  - TTL on `stoppedAt` keeps the collection from growing without bound; rows that
 *    have been marked stopped for 30 days are auto-removed. Active rows (no `stoppedAt`)
 *    are never expired by this TTL because partial filter is on `stoppedAt` exists.
 */
export function applyServiceUptimeIndexes(ServiceUptimeSchema: Schema): void {
    ServiceUptimeSchema.index({ service: 1, startedAt: -1 });
    ServiceUptimeSchema.index({ service: 1, stoppedAt: 1, lastSeenAt: -1 });
    ServiceUptimeSchema.index(
        { stoppedAt: 1 },
        {
            expireAfterSeconds: 30 * 24 * 60 * 60,
            partialFilterExpression: { stoppedAt: { $exists: true } }
        }
    );
}
