/**
 * Service Uptime Ledger
 *
 * Persistent record of every service start so `lastStart` and other uptime
 * indicators survive process restarts and redeploys.
 *
 * One document per process lifetime, per service. Updated by `UptimeKeeper`:
 *  - `markStart(...)` inserts a fresh row with `startedAt` and `lastSeenAt = now`.
 *  - `markHeartbeat(...)` updates `lastSeenAt` periodically while the service is alive.
 *  - `markStop(...)` writes `stoppedAt` on graceful shutdown.
 *
 * Health getters resolve `lastStart` by selecting the most recent active row
 * (no `stoppedAt`) per service for the current host/process; this keeps the
 * "uptime" badge in the admin UI accurate even when the service has been
 * connected since a previous deploy.
 *
 * @module database/core/schemas/serviceUptime/serviceUptime
 */

import mongoose, {Document, Schema, SchemaTypes} from "mongoose";
import {applyServiceUptimeIndexes} from "./serviceUptime.indexes";

/**
 * Logical service identifier. Mirrors the keys in the Health response.
 */
export type ServiceUptimeName = | "mongoDb" | "redis" | "kafka" | "websocket" | "telegram" | "api" | "websocketServer" | "kafkaServer" | "cronServer";
 
export interface IServiceUptime extends Document {
    service: ServiceUptimeName;
    serverName: string;
    processId: number;
    host: string;
    version: string;
    startedAt: Date;
    lastSeenAt: Date;
    stoppedAt?: Date;
}

export const ServiceUptimeSchema = new Schema<IServiceUptime>(
    {
        service: { type: SchemaTypes.String, required: true },
        serverName: { type: SchemaTypes.String, required: true },
        processId: { type: SchemaTypes.Number, required: true },
        host: { type: SchemaTypes.String, required: true, default: "" },
        version: { type: SchemaTypes.String, required: true, default: "" },
        startedAt: { type: SchemaTypes.Date, required: true },
        lastSeenAt: { type: SchemaTypes.Date, required: true },
        stoppedAt: { type: SchemaTypes.Date, required: false }
    },
    {
        timestamps: false,
        autoIndex: true
    }
);

applyServiceUptimeIndexes(ServiceUptimeSchema);

const ServiceUptime = mongoose.model<IServiceUptime>("ServiceUptime", ServiceUptimeSchema);
export default ServiceUptime;
