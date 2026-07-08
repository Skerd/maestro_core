import {Document, model, Schema, SchemaTypes, Types} from "mongoose";
import {normalizeSchemaPermissions} from "@coreModule/database/utilities";
import auditPlugin from "@coreModule/database/plugins/auditPlugin";
import softDeletePlugin from "@coreModule/database/plugins/softDeletePlugin";
import {ISoftDeletePluginFields} from "@coreModule/database/types/plugin-fields";
import {addModelData} from "@coreModule/database/collections";
import {validateSchemaDefAgainstMongoose} from "@coreModule/database/utilities/validateSchemaDefAgainstMongoose";
import {CronJobSchemaDef} from "armonia/src/modules/core/api/auxiliary/private/cronJob/cronJob.schema-def";
import type {
    CronExecutionStrategy,
    CronIntervalUnit,
    CronJobType,
    CronMissedRunPolicy,
    CronScope,
} from "armonia/src/modules/core/api/auxiliary/private/cronJob/cronJob.constants";
import {cronJobViews} from "@coreModule/database/schemas/cronJob/cronJob.views";
import {applyCronJobIndexes} from "@coreModule/database/schemas/cronJob/cronJob.indexes";
import {CronIntervalUnits} from "armonia/src/modules/core/api/auxiliary/private/cronJob/cronJob.constants";

export interface ICronJobInterval {
    value: number;
    unit: CronIntervalUnit;
}

export interface ICronJob extends Document, ISoftDeletePluginFields {
    company?: Types.ObjectId | null;
    scope: CronScope;
    code: string;
    name: string;
    description?: string;
    active: boolean;
    pausedAt?: Date;
    handler: string;
    type: CronJobType;
    cronExpression?: string;
    interval?: ICronJobInterval;
    timezone?: string;
    nextRunAt?: Date;
    lastRunAt?: Date;
    runImmediately?: boolean;
    maxRetries: number;
    retryDelaySeconds: number;
    timeoutSeconds?: number;
    singleton: boolean;
    allowParallelRuns: boolean;
    priority: number;
    executionStrategy: CronExecutionStrategy;
    queueName?: string;
    missedRunPolicy: CronMissedRunPolicy;
    maxConcurrentRuns?: number;
    dependsOn?: Types.ObjectId[];
    handlerVersion?: string;
    metadata?: Record<string, unknown>;
    tags?: string[];
    createdBy?: Types.ObjectId;
    createdAt: Date;
    updatedAt: Date;
}

const CronJobIntervalSchema = new Schema<ICronJobInterval>(
    {
        value: {type: SchemaTypes.Number, required: true, min: 1},
        unit: {
            type: SchemaTypes.String,
            required: true,
            enum: ["seconds", "minutes", "hours", "days"],
        },
    },
    {_id: false},
);

const CronJobSchema = new Schema<ICronJob>(
    {
        company: {
            type: SchemaTypes.ObjectId,
            ref: "Company",
            required: false,
            default: null,
            index: true,
        },
        scope: {
            type: SchemaTypes.String,
            required: true,
            enum: ["global", "company"],
            default: "global",
        },
        code: {type: SchemaTypes.String, required: true, trim: true},
        name: {type: SchemaTypes.String, required: true, trim: true},
        description: {type: SchemaTypes.String, required: false, default: ""},
        active: {type: SchemaTypes.Boolean, required: true, default: true},
        pausedAt: {type: SchemaTypes.Date, required: false},
        handler: {type: SchemaTypes.String, required: true, trim: true},
        type: {
            type: SchemaTypes.String,
            required: true,
            enum: ["interval", "cron", "once", "queue"],
        },
        cronExpression: {type: SchemaTypes.String, required: false, trim: true},
        interval: {type: CronJobIntervalSchema, required: false},
        timezone: {type: SchemaTypes.String, required: false, default: "UTC"},
        nextRunAt: {type: SchemaTypes.Date, required: false, index: true},
        lastRunAt: {type: SchemaTypes.Date, required: false},
        runImmediately: {type: SchemaTypes.Boolean, required: false, default: false},
        maxRetries: {type: SchemaTypes.Number, required: true, default: 3, min: 0},
        retryDelaySeconds: {type: SchemaTypes.Number, required: true, default: 60, min: 0},
        timeoutSeconds: {type: SchemaTypes.Number, required: false, default: 300, min: 1},
        singleton: {type: SchemaTypes.Boolean, required: true, default: true},
        allowParallelRuns: {type: SchemaTypes.Boolean, required: true, default: false},
        priority: {type: SchemaTypes.Number, required: true, default: 10, min: 0, max: 1000},
        executionStrategy: {
            type: SchemaTypes.String,
            required: true,
            enum: ["local", "distributed", "queue"],
            default: "distributed",
        },
        queueName: {type: SchemaTypes.String, required: false, trim: true},
        missedRunPolicy: {
            type: SchemaTypes.String,
            required: true,
            enum: ["catch_up", "skip", "run_once"],
            default: "skip",
        },
        maxConcurrentRuns: {type: SchemaTypes.Number, required: false, min: 1, max: 100},
        dependsOn: [{type: SchemaTypes.ObjectId, ref: "CronJob"}],
        handlerVersion: {type: SchemaTypes.String, required: false},
        metadata: {type: SchemaTypes.Mixed, required: false},
        tags: [{type: SchemaTypes.String, trim: true}],
        createdBy: {
            type: SchemaTypes.ObjectId,
            ref: "User",
            required: false,
        },
    },
    {accessMode: "loose", timestamps: true},
);

auditPlugin(CronJobSchema);
softDeletePlugin(CronJobSchema);
applyCronJobIndexes(CronJobSchema);
const CronJob = model<ICronJob>("CronJob", CronJobSchema);
normalizeSchemaPermissions(CronJob);
export default CronJob;

addModelData(CronJob, cronJobViews);
validateSchemaDefAgainstMongoose(CronJobSchema, CronJobSchemaDef, "CronJob", ["pausedAt", "nextRunAt", "lastRunAt", "dependsOn", "handlerVersion", "metadata",]);
