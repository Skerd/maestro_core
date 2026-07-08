/**
 * Server Performance — 1-minute rollups (Mongo time-series collection)
 *
 * One document per (method, endpoint) per minute, written by the metrics
 * aggregator's flush loop in the WebSocket process.
 *
 * Storage notes:
 *  - Backed by a Mongo time-series collection (Mongo 5.0+) with `granularity: "minutes"`.
 *  - `expireAfterSeconds` enforces a 7-day TTL so raw 1m rollups never grow without bound.
 *  - The metaField groups all entries for the same endpoint together for efficient scans.
 *
 * Long-term aggregates live in `serverPerformance1h` (90d TTL) and
 * `serverPerformance1d` (365d TTL).
 *
 * @module database/core/schemas/serverPerformance/serverPerformance1m
 */

import mongoose, {Schema, SchemaTypes} from "mongoose";

/** TTL: 7 days for raw 1-minute rollups. */
const TTL_SECONDS = 7 * 24 * 60 * 60;

export interface IServerPerformance1m {  
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

export const ServerPerformance1mSchema = new Schema<IServerPerformance1m>(
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
        // `errors` is a reserved pathname in Mongoose; we keep the DB field name for metrics.
        supressReservedKeysWarning: true,
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

const ServerPerformance1m = mongoose.model<IServerPerformance1m>(
    "ServerPerformance1m",
    ServerPerformance1mSchema,
    "serverPerformance1m"
);
export default ServerPerformance1m;
