// import {ObjectId} from "mongodb";
// import {createCrudRouter} from "@coreModule/api/crudRouterFactory";
// import CronJob from "@coreModule/database/schemas/cronJob/cronJob";
// import {cronJobService} from "@coreModule/database/schemas/cronJob/cronJob.service";
// import {
//     cronJobsToDTO,
//     cronJobToDTO,
// } from "@coreModule/utilities/mappers/cronJob/cronJobMapper.dto";
// import {cronJobsToSelect} from "@coreModule/utilities/mappers/cronJob/cronJobMapper.select";
// import {createCronJobFormSchema} from "armonia/src/modules/core/api/auxiliary/private/cronJob/createCronJob.form.validator";
// import {editCronJobFormSchema} from "armonia/src/modules/core/api/auxiliary/private/cronJob/editCronJob.form.validator";
// import {validateCronJobListForm} from "armonia/src/modules/core/api/auxiliary/private/cronJob/cronJobList.form.validator";
// import {assertCronHandlerRegistered} from "@coreModule/cronjobs/registry/handlerRegistry";
// import {computeNextRunAt, getNextRunsIso} from "@coreModule/cronjobs/scheduling/nextRunCalculator";
// import {buildCronJobListFilter} from "@coreModule/cronjobs/access/cronJobAccess";
// import CronExecution from "@coreModule/database/schemas/cronExecution/cronExecution";
// import {cronExecutionToSummary} from "@coreModule/utilities/mappers/cronJob/cronJobMapper.dto";
// import {CronJobActions} from "@coreModule/database/schemas/cronJob/cronJob.actions";
//
// export const basePath = "/api/auxiliary/cron-jobs";
//
// async function loadEnrichment(docs: { _id: ObjectId }[]) {
//     const ids = docs.map(d => d._id);
//     const executions = await CronExecution.aggregate([
//         {$match: {jobId: {$in: ids}}},
//         {$sort: {startedAt: -1}},
//         {$group: {_id: "$jobId", doc: {$first: "$$ROOT"}}},
//     ]);
//     const map = new Map<string, ReturnType<typeof cronExecutionToSummary>>();
//     for (const row of executions) {
//         map.set(row._id.toString(), cronExecutionToSummary(row.doc));
//     }
//     return map;
// }
//
// export const {router} = createCrudRouter({
//     collectionName: "cronjobs",
//     model: CronJob,
//     service: cronJobService,
//     createSchema: createCronJobFormSchema,
//     editSchema: editCronJobFormSchema,
//     listSchema: validateCronJobListForm,
//     toDTO: cronJobToDTO,
//     toDTOArray: cronJobsToDTO,
//     toSelect: cronJobsToSelect,
//     actions: CronJobActions,
//     entityName: "CronJob",
//     defaultSort: {priority: -1, nextRunAt: 1},
//     extraListFilter: async params => buildCronJobListFilter(params as any),
//     extraSelectFilter: async params => buildCronJobListFilter(params as any),
//     documentFilter: async params => buildCronJobListFilter(params as any),
//     buildCreateData: async params => {
//         const {
//             code,
//             name,
//             description,
//             active,
//             handler,
//             type,
//             cronExpression,
//             interval,
//             timezone,
//             runImmediately,
//             maxRetries,
//             retryDelaySeconds,
//             timeoutSeconds,
//             singleton,
//             allowParallelRuns,
//             priority,
//             executionStrategy,
//             queueName,
//             missedRunPolicy,
//             maxConcurrentRuns,
//             scope,
//             company: companyField,
//             tags,
//             metadata,
//         } = params;
//         assertCronHandlerRegistered(handler);
//         const company =
//             scope === "global"
//                 ? null
//                 : companyField
//                   ? new ObjectId(companyField)
//                   : params.company?._id ?? null;
//         const draft = {
//             code,
//             name,
//             description,
//             active: active ?? true,
//             handler,
//             type,
//             cronExpression,
//             interval,
//             timezone: timezone ?? "UTC",
//             runImmediately,
//             maxRetries,
//             retryDelaySeconds,
//             timeoutSeconds,
//             singleton,
//             allowParallelRuns,
//             priority,
//             executionStrategy,
//             queueName,
//             missedRunPolicy,
//             maxConcurrentRuns,
//             scope,
//             company,
//             tags,
//             metadata,
//         };
//         const nextRunAt =
//             runImmediately ? new Date() : computeNextRunAt(draft as any, new Date());
//         return {
//             ...draft,
//             nextRunAt,
//             createdBy: params.actionUserCtx?.userId
//                 ? new ObjectId(params.actionUserCtx.userId)
//                 : undefined,
//         };
//     },
//     buildUpdateData: async (params, writeFields) => {
//         const update: Record<string, unknown> = {};
//         const fields = [
//             "name",
//             "description",
//             "active",
//             "type",
//             "cronExpression",
//             "interval",
//             "timezone",
//             "maxRetries",
//             "retryDelaySeconds",
//             "timeoutSeconds",
//             "singleton",
//             "allowParallelRuns",
//             "priority",
//             "executionStrategy",
//             "queueName",
//             "missedRunPolicy",
//             "maxConcurrentRuns",
//             "tags",
//             "metadata",
//         ] as const;
//         for (const f of fields) {
//             if (params[f] !== undefined && writeFields[f]) {
//                 update[f] = params[f];
//             }
//         }
//         if (params.handler !== undefined && writeFields.handler) {
//             assertCronHandlerRegistered(params.handler);
//             update.handler = params.handler;
//         }
//         if (Object.keys(update).length > 0) {
//             const merged = {...params.existing?.toObject?.() ?? params.existing, ...update};
//             const nextRunAt = computeNextRunAt(merged, new Date());
//             if (nextRunAt) update.nextRunAt = nextRunAt;
//         }
//         return update;
//     },
//     enrichList: async docs => {
//         const lastMap = await loadEnrichment(docs);
//         const extras = new Map<string, {lastExecution?: any; nextRunsPreview?: string[]}>();
//         for (const doc of docs) {
//             const id = doc._id.toString();
//             extras.set(id, {
//                 lastExecution: lastMap.get(id) as any,
//                 nextRunsPreview: getNextRunsIso(doc as any, 5),
//             });
//         }
//         return cronJobsToDTO(docs, extras);
//     },
//     enrichSingle: async doc => {
//         const last = await CronExecution.findOne({jobId: doc._id}).sort({startedAt: -1});
//         return cronJobToDTO(doc as any, {
//             lastExecution: last ?? undefined,
//             nextRunsPreview: getNextRunsIso(doc as any, 10),
//         });
//     },
//     overrideSelectHandler: async params => {
//         const {logger, languageCode, name, page, limit} = params;
//         const filter = {
//             ...(await buildCronJobListFilter(params as any)),
//             deletedAt: null,
//         };
//         if (name) {
//             (filter as any).name = {$regex: name, $options: "i"};
//         }
//         const offset = (page - 1) * limit;
//         const [docs, total] = await Promise.all([
//             cronJobService.find(filter, {logger, languageCode}, null, "", {name: 1}, limit, offset),
//             cronJobService.count(filter, {logger, languageCode}),
//         ]);
//         return {data: cronJobsToSelect(docs), total};
//     },
// });
