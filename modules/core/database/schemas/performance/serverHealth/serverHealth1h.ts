/**
 * Server Health — 1-hour rollups (Mongo time-series collection)
 *
 * One document per (service) per hour, produced by the hourly rollup job
 * that aggregates `serverHealth1m` over the previous closed hour.
 *
 * Storage notes:
 *  - Mongo time-series collection (Mongo 5.0+), `granularity: "hours"`.
 *  - `expireAfterSeconds` enforces a 90-day TTL.
 *
 * @module database/core/schemas/serverHealth/serverHealth1h
 */

import mongoose, {Schema, SchemaTypes} from "mongoose";
import {ServerHealthServiceName} from "@coreModule/database/schemas/performance/serverHealth/serverHealth1m";

const TTL_SECONDS = 90 * 24 * 60 * 60;

export interface IServerHealth1h {
    bucketStart: Date;
    meta: { service: ServerHealthServiceName };
    /** Number of 1m samples included in this rollup (1..60). */
    samples: number;
    /** Number of samples observed in `up=1` state. */
    upSamples: number;
    /** Uptime% over the hour, in [0..1]. Stored to avoid recomputation on read. */
    uptimePct: number;
    /** Number of samples observed in `OPEN` circuit breaker state. */
    breakerOpenSamples: number;
    /** Sum of completedJobsDelta across all samples (= work in this hour). */
    completedJobs: number;
    /** Sum of failedJobsDelta across all samples. */
    failedJobs: number;
    /** Mean of per-sample averageTime weighted by op count. */ 
    averageTime: number;
}

export const ServerHealth1hSchema = new Schema<IServerHealth1h>(
    {
        bucketStart: { type: SchemaTypes.Date, required: true },
        meta: {
            service: { type: SchemaTypes.String, required: true }
        },
        samples: { type: SchemaTypes.Number, required: true, default: 0 },
        upSamples: { type: SchemaTypes.Number, required: true, default: 0 },
        uptimePct: { type: SchemaTypes.Number, required: true, default: 0 },
        breakerOpenSamples: { type: SchemaTypes.Number, required: true, default: 0 },
        completedJobs: { type: SchemaTypes.Number, required: true, default: 0 },
        failedJobs: { type: SchemaTypes.Number, required: true, default: 0 },
        averageTime: { type: SchemaTypes.Number, required: true, default: 0 }
    },
    {
        timeseries: {
            timeField: "bucketStart",
            metaField: "meta",
            granularity: "hours"
        },
        expireAfterSeconds: TTL_SECONDS,
        autoCreate: true,
        autoIndex: true
    } as any
);

const ServerHealth1h = mongoose.model<IServerHealth1h>(
    "ServerHealth1h",
    ServerHealth1hSchema,
    "serverHealth1h"
);
export default ServerHealth1h;
