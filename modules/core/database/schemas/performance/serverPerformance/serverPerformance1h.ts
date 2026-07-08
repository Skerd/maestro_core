/**
 * Server Performance — 1-hour rollups (Mongo time-series collection)
 *
 * One document per (method, endpoint) per hour, written by the hourly rollup
 * cron in the WebSocket process. Source data: `serverPerformance1m`.
 *
 * Storage notes:
 *  - Backed by a Mongo time-series collection with `granularity: "hours"`.
 *  - `expireAfterSeconds` enforces a 90-day TTL.
 *
 * @module database/core/schemas/serverPerformance/serverPerformance1h
 */

import mongoose, {Schema, SchemaTypes} from "mongoose";

/** TTL: 90 days for hourly rollups. */
const TTL_SECONDS = 90 * 24 * 60 * 60;

export interface IServerPerformance1h {
    bucketStart: Date;
    meta: {
        method: string;
        endpoint: string;
    };
    count: number;
    errors: number;
    sum: number;
    sumSq: number;
    min: number;
    max: number;
    p50: number;
    p95: number;
    p99: number;
    lastExecuted: Date;
}

export const ServerPerformance1hSchema = new Schema<IServerPerformance1h>(
    {
        bucketStart: { type: SchemaTypes.Date, required: true },
        meta: {
            method: { type: SchemaTypes.String, required: true },
            endpoint: { type: SchemaTypes.String, required: true }
        },
        count: { type: SchemaTypes.Number, required: true, default: 0 },
        errors: { type: SchemaTypes.Number, required: true, default: 0 },
        sum: { type: SchemaTypes.Number, required: true, default: 0 },
        sumSq: { type: SchemaTypes.Number, required: true, default: 0 },
        min: { type: SchemaTypes.Number, required: true, default: 0 },
        max: { type: SchemaTypes.Number, required: true, default: 0 },
        p50: { type: SchemaTypes.Number, required: true, default: 0 },
        p95: { type: SchemaTypes.Number, required: true, default: 0 },
        p99: { type: SchemaTypes.Number, required: true, default: 0 },
        lastExecuted: { type: SchemaTypes.Date, required: true }
    },
    {
        supressReservedKeysWarning: true,
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

const ServerPerformance1h = mongoose.model<IServerPerformance1h>(
    "ServerPerformance1h",
    ServerPerformance1hSchema,
    "serverPerformance1h"
);
export default ServerPerformance1h; 
