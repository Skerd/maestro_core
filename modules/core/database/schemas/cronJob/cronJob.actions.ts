import {ObjectId} from "mongodb";
import {action} from "@coreModule/api/actionDecorator";
import SchemaGuard from "@coreModule/database/security/schemaGuard";
import {COLLECTED_DATA} from "@coreModule/database/collections";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {computeNextRunAt, getNextRunsIso} from "@coreModule/cronjobs/scheduling/nextRunCalculator";
import CronJob from "@coreModule/database/schemas/cronJob/cronJob";
import {cronJobService} from "@coreModule/database/schemas/cronJob/cronJob.service";
import {cronExecutionService} from "@coreModule/database/schemas/cronExecution/cronExecution.service";
import {cronExecutionsToDTO, cronJobToDTO} from "@coreModule/utilities/mappers/cronJob/cronJobMapper.dto";
import type {
    CronJob as CronJobDTO,
    CronJobMetrics,
    CronJobRunsPreview,
} from "armonia/src/modules/core/api/auxiliary/private/cronJob/cronJob.dto";
import {validateSingleForm} from "armonia/src/modules/core/utilities/zod/shared.validator";
import {
    cronJobExecutionsFormSchema,
    previewCronJobRunsFormSchema,
} from "armonia/src/modules/core/api/auxiliary/private/cronJob/cronJob.form.validator";
import {schemaSanitizer} from "@coreModule/utilities/middlewares/schemaSanitizerMW";
import {dslFilterMW} from "@coreModule/utilities/middlewares/dslFilterMW";

const RUNS_PREVIEW_COUNT = 5;

function assertCanWriteActive(params: Record<string, any>): void {
    const {actionUserCtx, languageCode} = params;
    const writeFields = SchemaGuard.sanitizeFields(
        CronJob,
        COLLECTED_DATA.cronjobs.writeFields,
        "write",
        actionUserCtx,
        languageCode,
    );
    if (!writeFields.active) {
        throw apiValidationException("user_permissions_not_sufficient", "", null, languageCode);
    }
}

function isPaused(job: {active: boolean; pausedAt?: Date}): boolean {
    return !job.active || job.pausedAt != null;
}

/** Same rule as `isPaused`, as a query. */
const PAUSED_FILTER = {$or: [{active: false}, {pausedAt: {$ne: null}}]};

export class CronJobActions {

    @action({
        auth: "private",
        schema: validateSingleForm,
        transaction: true,
        rateLimit: {windowMs: 60000, max: 30},
    })
    async pause(params: Record<string, any>): Promise<CronJobDTO> {
        const {_id, company, logger, languageCode, session, actionUserCtx} = params;
        logger.start(`Pausing scheduled action: ${_id}`);
        assertCanWriteActive(params);

        const job = await cronJobService.findOneOrThrow(
            {_id: new ObjectId(_id), company: company._id},
            {session, logger, languageCode},
        );
        if (isPaused(job)) {
            throw apiValidationException("cron_job_already_paused", "", null, languageCode);
        }

        const updated = await cronJobService.updateByIdOrThrow(
            job._id,
            {
                $set: {
                    pausedAt: new Date(),
                    active: false,
                },
                $unset: {
                    nextRunAt: "",
                },
            },
            {session, logger, languageCode, auditUserId: actionUserCtx.userId},
        );
        logger.finish(`Paused scheduled action: ${_id}`);
        return cronJobToDTO(updated);
    }

    @action({
        auth: "private",
        schema: validateSingleForm,
        transaction: true,
        rateLimit: {windowMs: 60000, max: 30},
    })
    async resume(params: Record<string, any>): Promise<CronJobDTO> {
        const {_id, company, logger, languageCode, session, actionUserCtx} = params;
        logger.start(`Resuming scheduled action: ${_id}`);
        assertCanWriteActive(params);

        const job = await cronJobService.findOneOrThrow(
            {_id: new ObjectId(_id), company: company._id},
            {session, logger, languageCode},
        );
        if (!isPaused(job)) {
            throw apiValidationException("cron_job_not_paused", "", null, languageCode);
        }

        const nextRunAt = computeNextRunAt(job, new Date());
        if (!nextRunAt) {
            throw apiValidationException("cron_job_schedule_invalid", "", null, languageCode);
        }

        const updated = await cronJobService.updateByIdOrThrow(
            job._id,
            {
                $set: {
                    nextRunAt,
                    active: true,
                },
                $unset: {pausedAt: ""},
            },
            {session, logger, languageCode, auditUserId: actionUserCtx.userId},
        );
        logger.finish(`Resumed scheduled action: ${_id}`);
        return cronJobToDTO(updated);
    }

    /** Makes the job due now; the scheduler starts it on its next tick, and the schedule then carries on. */
    @action({
        auth: "private",
        schema: validateSingleForm,
        rateLimit: {windowMs: 60000, max: 30},
    })
    async run(params: Record<string, any>): Promise<CronJobDTO> {
        const {_id, company, logger, languageCode, actionUserCtx} = params;
        logger.start(`Running scheduled action: ${_id}`);
        assertCanWriteActive(params);

        const job = await cronJobService.findOneOrThrow(
            {_id: new ObjectId(_id), company: company._id},
            {logger, languageCode},
        );
        if (isPaused(job)) {
            throw apiValidationException("cron_job_inactive", "", null, languageCode);
        }

        const updated = await cronJobService.updateByIdOrThrow(
            job._id,
            {$set: {nextRunAt: new Date()}},
            {logger, languageCode, auditUserId: actionUserCtx.userId},
        );
        logger.finish(`Queued scheduled action: ${_id}`);
        return cronJobToDTO(updated);
    }

    @action({
        schema: cronJobExecutionsFormSchema,
        rateLimit: {windowMs: 60000, max: 60},
        middleware: [
            schemaSanitizer({model: "cronexecutions", requiredModes: ["read"]}),
            dslFilterMW({model: "cronexecutions"}),
        ],
    })
    async executions(params: Record<string, any>) {
        const {offset = 0, limit = 50, jobId, dslFilterQuery, company, logger, languageCode} = params;
        const mongoFilter: Record<string, unknown> = {company: company._id};
        if (jobId) {
            mongoFilter.jobId = new ObjectId(jobId);
        }
        if (dslFilterQuery && Object.keys(dslFilterQuery as object).length > 0) {
            mongoFilter.$and = [dslFilterQuery];
        }
        const [docs, total] = await Promise.all([
            cronExecutionService.find(
                mongoFilter,
                {logger, languageCode},
                null,
                "",
                {startedAt: -1},
                limit,
                offset,
            ),
            cronExecutionService.count(mongoFilter, {logger, languageCode}),
        ]);
        return {data: cronExecutionsToDTO(docs), total};
    }

    @action({auth: "private", rateLimit: {windowMs: 60000, max: 60}})
    async metrics(params: Record<string, any>): Promise<CronJobMetrics> {
        const company = params.company._id;
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const opts = {logger: params.logger, languageCode: params.languageCode};
        const [totalJobs, pausedJobs, runningExecutions, failedLast24h, successLast24h, agg] =
            await Promise.all([
                cronJobService.count({company}, {...opts, withDeleted: false}),
                cronJobService.count({company, ...PAUSED_FILTER}, {...opts, withDeleted: false}),
                cronExecutionService.count({company, status: "running"}, opts),
                cronExecutionService.count({company, status: {$in: ["failed", "timeout"]}, startedAt: {$gte: since}}, opts),
                cronExecutionService.count({company, status: "success", startedAt: {$gte: since}}, opts),
                cronExecutionService.aggregate([
                    {$match: {company, status: "success", startedAt: {$gte: since}, durationMs: {$exists: true}}},
                    {$group: {_id: null, avg: {$avg: "$durationMs"}}},
                ], opts),
            ]);
        return {
            totalJobs,
            activeJobs: totalJobs - pausedJobs,
            pausedJobs,
            runningExecutions,
            failedLast24h,
            successLast24h,
            avgDurationMsLast24h: agg[0]?.avg ?? 0,
        };
    }

    @action({auth: "private", schema: previewCronJobRunsFormSchema, rateLimit: {windowMs: 60000, max: 120}})
    async previewNextRuns(params: Record<string, any>): Promise<CronJobRunsPreview> {
        const {_id, cronExpression, company, logger, languageCode} = params;
        const job = await cronJobService.findOneOrThrow(
            {_id: new ObjectId(_id), company: company._id},
            {logger, languageCode},
        );
        const schedule = {cronExpression: cronExpression ?? job.cronExpression};
        const nextRunsPreview = getNextRunsIso(schedule, RUNS_PREVIEW_COUNT);
        return {valid: nextRunsPreview.length > 0, nextRunsPreview};
    }
}
