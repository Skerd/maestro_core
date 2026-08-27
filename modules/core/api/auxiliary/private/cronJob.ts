import {z} from "zod";
import {createCrudRouter} from "@coreModule/api/crudRouterFactory";
import CronJob, {type ICronJob} from "@coreModule/database/schemas/cronJob/cronJob";
import {cronJobService} from "@coreModule/database/schemas/cronJob/cronJob.service";
import {cronExecutionService} from "@coreModule/database/schemas/cronExecution/cronExecution.service";
import {
    cronJobsToDTO,
    cronJobToDTO,
    type CronJobDtoExtras,
} from "@coreModule/utilities/mappers/cronJob/cronJobMapper.dto";
import {cronJobsToSelect} from "@coreModule/utilities/mappers/cronJob/cronJobMapper.select";
import {editCronJobFormSchema} from "armonia/src/modules/core/api/auxiliary/private/cronJob/editCronJob.form.validator";
import {CronJobSchemaDef} from "armonia/src/modules/core/api/auxiliary/private/cronJob/cronJob.schema-def";
import {buildUpdateDataFromSchemaDef} from "@coreModule/api/buildUpdateDataFromSchemaDef";
import {computeNextRunAt, getNextRunsIso} from "@coreModule/cronjobs/scheduling/nextRunCalculator";
import {CronJobActions} from "@coreModule/database/schemas/cronJob/cronJob.actions";

export const basePath = "/api/auxiliary/cron-jobs";

const SCHEDULE_UPDATE_KEYS = ["cronExpression"] as const;

function scheduleFieldsChanged(update: Record<string, unknown>): boolean {
    return SCHEDULE_UPDATE_KEYS.some((key) => update[key] !== undefined);
}

export const {router} = createCrudRouter({
    collectionName: "cronjobs",
    model: CronJob,
    service: cronJobService,
    createSchema: () => z.looseObject({}),
    editSchema: editCronJobFormSchema,
    toDTO: cronJobToDTO,
    toDTOArray: cronJobsToDTO,
    toSelect: cronJobsToSelect,
    actions: CronJobActions,
    entityName: "CronJob",
    defaultSort: {priority: -1, nextRunAt: 1},
    buildCreateData: () => ({}),
    buildUpdateData: async (params, writeFields) => {
        const update = buildUpdateDataFromSchemaDef(CronJobSchemaDef)(params, writeFields);
        if (Object.keys(update).length === 0) {
            return update;
        }
        if (!scheduleFieldsChanged(update)) {
            return update;
        }
        const existing = params.existing as ICronJob;
        const nextRunAt = computeNextRunAt({...existing.toObject(), ...update}, new Date());
        if (nextRunAt) {
            update.nextRunAt = nextRunAt;
        }
        return update;
    },
    enrichList: async (docs, params) => {
        const lastMap = await cronExecutionService.latestByJobIds(
            docs.map((d) => d._id),
            params.company._id,
            {logger: params.logger, languageCode: params.languageCode},
        );
        const extras = new Map<string, CronJobDtoExtras>();
        for (const doc of docs) {
            const id = doc._id.toString();
            extras.set(id, {
                lastExecution: lastMap.get(id),
                nextRunsPreview: getNextRunsIso(doc, 5),
            });
        }
        return cronJobsToDTO(docs, extras);
    },
    enrichSingle: async (doc, params) => {
        const lastMap = await cronExecutionService.latestByJobIds(
            [doc._id],
            params.company._id,
            {logger: params.logger, languageCode: params.languageCode},
        );
        return cronJobToDTO(doc, {
            lastExecution: lastMap.get(doc._id.toString()),
            nextRunsPreview: getNextRunsIso(doc, 10),
        });
    },
});
