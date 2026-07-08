import {ObjectId} from "mongodb";
import {action} from "@coreModule/api/actionDecorator";
import {buildCronJobIdFilter, buildCronJobListFilter} from "@coreModule/cronjobs/access/cronJobAccess";
import {computeNextRunAt, getNextRunsIso} from "@coreModule/cronjobs/scheduling/nextRunCalculator";
import {jobRunner} from "@coreModule/cronjobs/engine/jobRunner";
import {cronJobService} from "@coreModule/database/schemas/cronJob/cronJob.service";
import {cronExecutionService} from "@coreModule/database/schemas/cronExecution/cronExecution.service";
import CronExecution from "@coreModule/database/schemas/cronExecution/cronExecution";
import {
    validateCronJobExecutionsListForm,
} from "armonia/src/modules/core/api/auxiliary/private/cronJob/editCronJob.form.validator";
import {cronExecutionsToDTO} from "@coreModule/utilities/mappers/cronJob/cronJobMapper.dto";
import type {CronJobMetrics} from "armonia/src/modules/core/api/auxiliary/private/cronJob/cronJob.dto";
import {validateSingleForm} from "armonia/src/modules/core/utilities/zod/shared.validator";

export class CronJobActions {
    @action({schema: validateSingleForm, rateLimit: {windowMs: 60000, max: 30}})
    async run(params: any) {
        const {_id, logger, languageCode} = params;
        const filter = await buildCronJobIdFilter(_id, params);
        const job = await cronJobService.findOneOrThrow(filter, {logger, languageCode});
        const execution = await jobRunner.runJob(job, {manual: true, parentLogger: logger});
        return {
            message: execution ? "Cron job triggered" : "Cron job skipped (inactive, locked, or concurrency limit)",
            executionId: execution?._id?.toString(),
        };
    }

    @action({schema: validateSingleForm})
    async pause(params: any) {
        const {_id, logger, languageCode} = params;
        const filter = await buildCronJobIdFilter(_id, params);
        const job = await cronJobService.findOneOrThrow(filter, {logger, languageCode});
        await cronJobService.updateById(
            job._id,
            {$set: {pausedAt: new Date()}},
            {logger, languageCode},
        );
        return {message: "Cron job paused"};
    }

    @action({schema: validateSingleForm})
    async resume(params: any) {
        const {_id, logger, languageCode} = params;
        const filter = await buildCronJobIdFilter(_id, params);
        const job = await cronJobService.findOneOrThrow(filter, {logger, languageCode});
        const nextRunAt = computeNextRunAt(job, new Date()) ?? new Date();
        await cronJobService.updateById(
            job._id,
            {$set: {nextRunAt}, $unset: {pausedAt: 1}},
            {logger, languageCode},
        );
        return {message: "Cron job resumed"};
    }

    @action({schema: validateCronJobExecutionsListForm, rateLimit: {windowMs: 60000, max: 60}})
    async executions(params: any) {
        const {jobId, offset = 0, limit = 50, status, logger, languageCode} = params;
        await buildCronJobIdFilter(jobId, params);
        const filter: Record<string, unknown> = {jobId: new ObjectId(jobId)};
        if (status) filter.status = status;
        const [docs, total] = await Promise.all([
            cronExecutionService.find(
                filter,
                {logger, languageCode},
                null,
                "",
                {startedAt: -1},
                limit,
                offset,
            ),
            cronExecutionService.count(filter, {logger, languageCode}),
        ]);
        return {data: cronExecutionsToDTO(docs), total};
    }

    @action({auth: "private", rateLimit: {windowMs: 60000, max: 60}})
    async metrics(params: any): Promise<CronJobMetrics> {
        const listFilter = await buildCronJobListFilter(params);
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const [totalJobs, activeJobs, pausedJobs, runningExecutions, failedLast24h, successLast24h, agg] =
            await Promise.all([
                cronJobService.count({...listFilter, deletedAt: null}, {logger: params.logger, languageCode: params.languageCode}),
                cronJobService.count({...listFilter, active: true, pausedAt: null, deletedAt: null}, {logger: params.logger, languageCode: params.languageCode}),
                cronJobService.count({...listFilter, pausedAt: {$exists: true}, deletedAt: null}, {logger: params.logger, languageCode: params.languageCode}),
                CronExecution.countDocuments({status: "running"}),
                CronExecution.countDocuments({status: "failed", startedAt: {$gte: since}}),
                CronExecution.countDocuments({status: "success", startedAt: {$gte: since}}),
                CronExecution.aggregate([
                    {$match: {status: "success", startedAt: {$gte: since}, durationMs: {$exists: true}}},
                    {$group: {_id: null, avg: {$avg: "$durationMs"}}},
                ]),
            ]);
        return {
            totalJobs,
            activeJobs,
            pausedJobs,
            runningExecutions,
            failedLast24h,
            successLast24h,
            avgDurationMsLast24h: agg[0]?.avg ?? 0,
        };
    }

    @action({auth: "private"})
    async previewNextRuns(params: any) {
        const {_id, logger, languageCode} = params;
        const filter = await buildCronJobIdFilter(_id, params);
        const job = await cronJobService.findOneOrThrow(filter, {logger, languageCode});
        return {nextRunsPreview: getNextRunsIso(job, 10)};
    }
}
