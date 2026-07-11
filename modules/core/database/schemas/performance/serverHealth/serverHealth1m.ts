/**
 * Server Health — 1-minute snapshots (Mongo time-series collection)
 *
 * One document per (service) per minute, written by the WebSocket server
 * process's snapshot job. Captures the connected/disconnected state of each
 * monitored service so we can plot uptime% over arbitrary time ranges.
 *
 * Why a snapshot rather than an event-log model?
 *  - Health is a continuous-state observation, not a discrete event.
 *    Periodic sampling at 1-minute granularity gives sub-minute SLO accuracy
 *    without unbounded write amplification.
 *  - One row per minute per service is bounded: ~5 rows / minute * 60 / hour
 *    * 24 / day = 7,200 rows / day, easily handled by time-series compression.
 *
 * Storage notes:
 *  - Mongo time-series collection (Mongo 5.0+), `granularity: "minutes"`.
 *  - `expireAfterSeconds` enforces a 7-day TTL.
 *  - `meta.service` groups all rows for the same service for efficient scans.
 *
 * Roll-up paths:
 *  - 1m → 1h aggregator runs at the top of every hour (90d retention).
 *  - 1h → 1d aggregator runs once a day (365d retention).
 *
 * @module database/core/schemas/serverHealth/serverHealth1m 
 */

import mongoose, {Schema, SchemaTypes} from "mongoose";

const TTL_SECONDS = 7 * 24 * 60 * 60;

export type ServerHealthServiceName = | "mongoDb" | "redis" | "kafka" | "websocket" | "telegram" | "assistant" | "cronScheduler" | "apiServer";

export interface IServerHealth1m {
    bucketStart: Date;
    meta: { service: ServerHealthServiceName };
    /** 1 = up, 0 = down. Stored numerically for cheap `$avg` uptime%. */
    up: number;
    /** Most-recent circuit breaker state observed during the bucket. */
    circuitBreakerState: "CLOSED" | "OPEN" | "HALF_OPEN";
    /** Net work completed during this minute (delta of completedJobs). */
    completedJobsDelta: number;
    /** Net work failed during this minute (delta of failedJobs). */
    failedJobsDelta: number;
    /** Average operation duration in ms during this minute (0 when no ops). */
    averageTime: number;
}

export const ServerHealth1mSchema = new Schema<IServerHealth1m>(
    {
        bucketStart: { type: SchemaTypes.Date, required: true },
        meta: {
            service: { type: SchemaTypes.String, required: true }
        },
        up: { type: SchemaTypes.Number, required: true, default: 0 },
        circuitBreakerState: { type: SchemaTypes.String, required: true, default: "CLOSED" },
        completedJobsDelta: { type: SchemaTypes.Number, required: true, default: 0 },
        failedJobsDelta: { type: SchemaTypes.Number, required: true, default: 0 },
        averageTime: { type: SchemaTypes.Number, required: true, default: 0 }
    },
    {
        timeseries: {
            timeField: "bucketStart",
            metaField: "meta",
            granularity: "minutes"
        },
        expireAfterSeconds: TTL_SECONDS,
        autoCreate: true,
        autoIndex: true
    } as any
);

const ServerHealth1m = mongoose.model<IServerHealth1m>(
    "ServerHealth1m",
    ServerHealth1mSchema,
    "serverHealth1m"
);
export default ServerHealth1m;
