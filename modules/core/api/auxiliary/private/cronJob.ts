import {z} from "zod";
import {createCrudRouter} from "@coreModule/api/crudRouterFactory";
import CronJob, {type ICronJob} from "@coreModule/database/schemas/cronJob/cronJob";
import {cronJobService} from "@coreModule/database/schemas/cronJob/cronJob.service";
import {cronExecutionService} from "@coreModule/database/schemas/cronExecution/cronExecution.service";
import {cronJobsToDTO, cronJobToDTO} from "@coreModule/utilities/mappers/cronJob/cronJobMapper.dto";
import {cronJobsToSelect} from "@coreModule/utilities/mappers/cronJob/cronJobMapper.select";
import {editCronJobFormSchema} from "armonia/src/modules/core/api/auxiliary/private/cronJob/editCronJob.form.validator";
import {CronJobSchemaDef} from "armonia/src/modules/core/api/auxiliary/private/cronJob/cronJob.schema-def";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {buildUpdateDataFromSchemaDef} from "@coreModule/api/buildUpdateDataFromSchemaDef";
import {computeNextRunAt, getNextRunsIso} from "@coreModule/cronjobs/scheduling/nextRunCalculator";
import {CronJobActions} from "@coreModule/database/schemas/cronJob/cronJob.actions";

export const basePath = "/api/auxiliary/cron-jobs";

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
        if (update.cronExpression === undefined) {
            return update;
        }
        const existing = params.existing as ICronJob;
        const nextRunAt = computeNextRunAt({...existing.toObject(), ...update}, new Date());
        // An expression that never fires would leave the job silently unscheduled.
        if (!nextRunAt) {
            throw apiValidationException("cron_job_schedule_invalid", "", null, params.languageCode);
        }
        // A paused job has no nextRunAt; resuming computes it.
        if (existing.active && !existing.pausedAt) {
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
        return cronJobsToDTO(docs, new Map(
            docs.map((doc) => [doc._id.toString(), {lastExecution: lastMap.get(doc._id.toString())}]),
        ));
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
