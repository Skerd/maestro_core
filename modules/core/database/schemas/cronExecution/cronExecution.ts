import {Document, model, Schema, SchemaTypes, Types} from "mongoose";
import {normalizeSchemaPermissions} from "@coreModule/database/utilities";
import {addModelData} from "@coreModule/database/collections";
import {applyCronExecutionIndexes} from "@coreModule/database/schemas/cronExecution/cronExecution.indexes";
import {CRON_EXECUTION_STATUSES} from "armonia/src/modules/core/api/auxiliary/private/cronJob/cronJob.constants";

export type CronExecutionStatus = (typeof CRON_EXECUTION_STATUSES)[number];

const publicRead = {
    self: {write: "no-permission"},
    others: {write: "no-permission"},
};

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
        jobId: {
            type: SchemaTypes.ObjectId,
            ref: "CronJob",
            required: true,
            index: true,
            dynamicTableConfiguration: {},
            permissions: publicRead,
        },
        company: {type: SchemaTypes.ObjectId, ref: "Company", required: false, default: null},
        status: {
            type: SchemaTypes.String,
            required: true,
            enum: [...CRON_EXECUTION_STATUSES],
            default: "running",
            dynamicTableConfiguration: {},
            permissions: publicRead,
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
    {
        accessMode: "loose",
        timestamps: true,
        permissions: {
            self: {
                create: "no-permission",
                delete: "no-permission",
                restore: "no-permission",
            },
        },
    },
);

applyCronExecutionIndexes(CronExecutionSchema);
const CronExecution = model<ICronExecution>("CronExecution", CronExecutionSchema);
normalizeSchemaPermissions(CronExecution);
export default CronExecution;

addModelData(CronExecution);
