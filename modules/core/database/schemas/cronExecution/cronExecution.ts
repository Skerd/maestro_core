import {Document, model, Schema, SchemaTypes, Types} from "mongoose";
import {applyCronExecutionIndexes} from "@coreModule/database/schemas/cronExecution/cronExecution.indexes";

export type CronExecutionStatus = "running" | "success" | "failed" | "timeout" | "cancelled";

export interface ICronExecution extends Document {
    jobId: Types.ObjectId;
    company?: Types.ObjectId | null;
    status: CronExecutionStatus;
    startedAt: Date;
    finishedAt?: Date;
    durationMs?: number;
    serverId?: string;
    attempt: number;
    nextRetryAt?: Date;
    logs?: string[];
    error?: {message: string; stack?: string};
    metadata?: Record<string, unknown>;
    createdAt: Date;
    updatedAt: Date;
}

const CronExecutionSchema = new Schema<ICronExecution>(
    {
        jobId: {type: SchemaTypes.ObjectId, ref: "CronJob", required: true, index: true},
        company: {type: SchemaTypes.ObjectId, ref: "Company", required: false, default: null},
        status: {
            type: SchemaTypes.String,
            required: true,
            enum: ["running", "success", "failed", "timeout", "cancelled"],
            default: "running",
        },
        startedAt: {type: SchemaTypes.Date, required: true, default: () => new Date()},
        finishedAt: {type: SchemaTypes.Date, required: false},
        durationMs: {type: SchemaTypes.Number, required: false},
        serverId: {type: SchemaTypes.String, required: false},
        attempt: {type: SchemaTypes.Number, required: true, default: 1, min: 1},
        nextRetryAt: {type: SchemaTypes.Date, required: false},
        logs: [{type: SchemaTypes.String}],
        error: {
            message: {type: SchemaTypes.String},
            stack: {type: SchemaTypes.String},
        },
        metadata: {type: SchemaTypes.Mixed, required: false},
    },
    {timestamps: true},
);

applyCronExecutionIndexes(CronExecutionSchema);

const CronExecution = model<ICronExecution>("CronExecution", CronExecutionSchema);
export default CronExecution;
