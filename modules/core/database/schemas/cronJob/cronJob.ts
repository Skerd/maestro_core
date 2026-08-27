import {Document, model, Schema, SchemaTypes} from "mongoose";
import {normalizeSchemaPermissions} from "@coreModule/database/utilities";
import ownershipPlugin from "@coreModule/database/plugins/ownershipPlugin";
import auditPlugin from "@coreModule/database/plugins/auditPlugin";
import softDeletePlugin from "@coreModule/database/plugins/softDeletePlugin";
import lifeCyclePlugin from "@coreModule/database/plugins/lifeCyclePlugin";
import {
    ILifeCyclePluginFields,
    IOwnershipPluginFields,
    ISoftDeletePluginFields
} from "@coreModule/database/types/plugin-fields";
import {addModelData} from "@coreModule/database/collections";
import {validateSchemaDefAgainstMongoose} from "@coreModule/database/utilities/validateSchemaDefAgainstMongoose";
import {
    CronJobSchemaDef,
    CRON_JOB_CRON_EXPRESSION_MAX,
    CRON_JOB_DESCRIPTION_MAX,
    CRON_JOB_MAX_RETRIES_MAX,
    CRON_JOB_NAME_MAX,
    CRON_JOB_NAME_MIN,
    CRON_JOB_PRIORITY_MAX,
    CRON_JOB_RETRY_DELAY_SECONDS_MAX,
    CRON_JOB_TIMEOUT_SECONDS_MAX,
    CRON_JOB_TIMEOUT_SECONDS_MIN,
} from "armonia/src/modules/core/api/auxiliary/private/cronJob/cronJob.schema-def";
import {CRON_MISSED_RUN_POLICIES, type CronMissedRunPolicy} from "armonia/src/modules/core/api/auxiliary/private/cronJob/cronJob.constants";
import {cronJobViews} from "@coreModule/database/schemas/cronJob/cronJob.views";
import {applyCronJobIndexes} from "@coreModule/database/schemas/cronJob/cronJob.indexes";

const backendOwned = {
    self: {write: "no-permission"},
    others: {write: "no-permission"},
};

export interface ICronJob extends Document, IOwnershipPluginFields, ISoftDeletePluginFields, ILifeCyclePluginFields {
    code: string;
    name: string;
    description?: string;
    active: boolean;
    pausedAt?: Date;
    handler: string;
    cronExpression: string;
    nextRunAt?: Date;
    lastRunAt?: Date;
    maxRetries: number;
    retryDelaySeconds: number;
    timeoutSeconds?: number;
    priority: number;
    missedRunPolicy: CronMissedRunPolicy;
}

const CronJobSchema = new Schema<ICronJob>(
    {
        code: {
            type: SchemaTypes.String, 
            required: true, 
            trim: true, 
            permissions: backendOwned
        },
        name: {
            type: SchemaTypes.String, 
            required: true, 
            trim: true,
            minlength: CRON_JOB_NAME_MIN,
            maxlength: CRON_JOB_NAME_MAX,
        },
        description: {
            type: SchemaTypes.String, 
            required: false, 
            default: "",
            maxlength: CRON_JOB_DESCRIPTION_MAX,
        },
        active: {
            type: SchemaTypes.Boolean, 
            required: true, 
            default: true
        },
        pausedAt: {
            type: SchemaTypes.Date, 
            required: false, 
            permissions: backendOwned
        },
        handler: {
            type: SchemaTypes.String,
            required: true, 
            trim: true, 
            permissions: backendOwned
        },
        cronExpression: {
            type: SchemaTypes.String,
            required: true,
            trim: true,
            minlength: 1,
            maxlength: CRON_JOB_CRON_EXPRESSION_MAX,
        },
        nextRunAt: {
            type: SchemaTypes.Date, 
            required: false, 
            index: true, 
            permissions: backendOwned
        },
        lastRunAt: {
            type: SchemaTypes.Date, 
            required: false, 
            permissions: backendOwned
        },
        maxRetries: {
            type: SchemaTypes.Number, 
            required: true, 
            default: 3, 
            min: 0,
            max: CRON_JOB_MAX_RETRIES_MAX,
        },
        retryDelaySeconds: {
            type: SchemaTypes.Number, 
            required: true, 
            default: 60, 
            min: 0,
            max: CRON_JOB_RETRY_DELAY_SECONDS_MAX,
        },
        timeoutSeconds: {
            type: SchemaTypes.Number, 
            required: false, 
            default: 300, 
            min: CRON_JOB_TIMEOUT_SECONDS_MIN,
            max: CRON_JOB_TIMEOUT_SECONDS_MAX,
        },
        priority: {
            type: SchemaTypes.Number, 
            required: true, 
            default: 10, 
            min: 0, 
            max: CRON_JOB_PRIORITY_MAX,
        },
        missedRunPolicy: {
            type: SchemaTypes.String,
            required: true,
            enum: CRON_MISSED_RUN_POLICIES,
            default: "skip",
        },
    },
    {
        accessMode: "loose",
        permissions: {
            self: {
                create: "no-permission",
                delete: "no-permission",
                restore: "no-permission",
            },
            others: {
                create: "no-permission",
                delete: "no-permission",
                restore: "no-permission",
            }
        }
    },
);

ownershipPlugin(CronJobSchema);
auditPlugin(CronJobSchema);
softDeletePlugin(CronJobSchema);
lifeCyclePlugin(CronJobSchema);
applyCronJobIndexes(CronJobSchema);
const CronJob = model<ICronJob>("CronJob", CronJobSchema);
normalizeSchemaPermissions(CronJob);
export default CronJob;

addModelData(CronJob, cronJobViews);
validateSchemaDefAgainstMongoose(CronJobSchema, CronJobSchemaDef, "CronJob", ["active", "code", "handler"]);
