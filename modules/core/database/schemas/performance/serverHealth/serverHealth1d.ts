/**
 * Server Health — 1-day rollups (Mongo time-series collection)
 *
 * One document per (service) per day, produced by the daily rollup job that
 * aggregates `serverHealth1h` over the previous closed UTC day.
 *
 * Storage notes:
 *  - Mongo time-series collection, `granularity: "hours"` (24 hours per row).
 *  - `expireAfterSeconds` enforces a 365-day TTL.
 *
 * @module database/core/schemas/serverHealth/serverHealth1d
 */

import mongoose, {Schema, SchemaTypes} from "mongoose";
import {ServerHealthServiceName} from "@coreModule/database/schemas/performance/serverHealth/serverHealth1m";

const TTL_SECONDS = 365 * 24 * 60 * 60;

export interface IServerHealth1d {
    bucketStart: Date;
    meta: { service: ServerHealthServiceName };
    samples: number;
    upSamples: number;
    uptimePct: number;
    breakerOpenSamples: number;
    completedJobs: number;
    failedJobs: number;
    averageTime: number;
}

export const ServerHealth1dSchema = new Schema<IServerHealth1d>( 
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

const ServerHealth1d = mongoose.model<IServerHealth1d>(
    "ServerHealth1d",
    ServerHealth1dSchema,
    "serverHealth1d"
);
export default ServerHealth1d;
