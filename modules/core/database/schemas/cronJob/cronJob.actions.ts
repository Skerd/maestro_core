import {ObjectId} from "mongodb";
import {action} from "@coreModule/api/actionDecorator";
import SchemaGuard from "@coreModule/database/security/schemaGuard";
import {COLLECTED_DATA} from "@coreModule/database/collections";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {computeNextRunAt, getNextRunsIso} from "@coreModule/cronjobs/scheduling/nextRunCalculator";
import {kafkaQueueAdapter} from "@coreModule/cronjobs/adapters/kafkaQueueAdapter";
import CronJob from "@coreModule/database/schemas/cronJob/cronJob";
import {cronJobService} from "@coreModule/database/schemas/cronJob/cronJob.service";
import {cronExecutionService} from "@coreModule/database/schemas/cronExecution/cronExecution.service";
import {validateCronJobExecutionsListForm} from "armonia/src/modules/core/api/auxiliary/private/cronJob/cronJobExecutions.form.validator";
import {cronExecutionsToDTO, cronJobToDTO} from "@coreModule/utilities/mappers/cronJob/cronJobMapper.dto";
import type {CronJob as CronJobDTO, CronJobMetrics} from "armonia/src/modules/core/api/auxiliary/private/cronJob/cronJob.dto";
import {validateSingleForm} from "armonia/src/modules/core/utilities/zod/shared.validator";
import {schemaSanitizer} from "@coreModule/utilities/middlewares/schemaSanitizerMW";
import {dslFilterMW} from "@coreModule/utilities/middlewares/dslFilterMW";

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

    @action({
        auth: "private",
        schema: validateSingleForm,
        rateLimit: {windowMs: 60000, max: 30},
    })
    async run(params: Record<string, any>): Promise<CronJobDTO> {
        const {_id, company, logger, languageCode} = params;
        logger.start(`Running scheduled action: ${_id}`);
        assertCanWriteActive(params);

        const filter = {_id: new ObjectId(_id), company: company._id};
        const job = await cronJobService.findOneOrThrow(filter, {logger, languageCode});
        if (isPaused(job)) {
            throw apiValidationException("cron_job_inactive", "", null, languageCode);
        }

        try {
            await kafkaQueueAdapter.enqueue({
                jobId: job._id.toString(),
                attempt: 1,
                company: company._id.toString(),
                handler: job.handler,
                enqueuedAt: new Date().toISOString(),
                manual: true,
            });
        } catch (e: unknown) {
            logger.err(`Failed to enqueue scheduled action ${_id}: ${e instanceof Error ? e.message : String(e)}`);
            throw apiValidationException("cron_job_kafka_unavailable", "", null, languageCode);
        }

        const fresh = await cronJobService.findOneOrThrow(filter, {logger, languageCode});
        logger.finish(`Enqueued scheduled action: ${_id}`);
        return cronJobToDTO(fresh);
    }

    @action({
        schema: validateCronJobExecutionsListForm,
        rateLimit: {windowMs: 60000, max: 60},
        middleware: [
            schemaSanitizer({model: "cronexecutions", requiredModes: ["read"]}),
            dslFilterMW({model: "cronexecutions"}),
        ],
    })
    async executions(params: Record<string, any>) {
        const {offset = 0, limit = 50, dslFilterQuery, company, logger, languageCode} = params;
        const mongoFilter: Record<string, unknown> = {company: company._id};
        if (dslFilterQuery && Object.keys(dslFilterQuery as object).length > 0) {
            mongoFilter.$and = [...((mongoFilter.$and as unknown[]) ?? []), dslFilterQuery];
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
        const companyFilter = {company: params.company._id};
        const executionCompany = {company: params.company._id};
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const opts = {logger: params.logger, languageCode: params.languageCode};
        const [totalJobs, activeJobs, pausedJobs, runningExecutions, failedLast24h, successLast24h, agg] =
            await Promise.all([
                cronJobService.count({...companyFilter, deletedAt: null}, opts),
                cronJobService.count({...companyFilter, active: true, pausedAt: null, deletedAt: null}, opts),
                cronJobService.count({...companyFilter, pausedAt: {$exists: true}, deletedAt: null}, opts),
                cronExecutionService.count({...executionCompany, status: "running"}, opts),
                cronExecutionService.count({...executionCompany, status: "failed", startedAt: {$gte: since}}, opts),
                cronExecutionService.count({...executionCompany, status: "success", startedAt: {$gte: since}}, opts),
                cronExecutionService.aggregate([
                    {$match: {...executionCompany, status: "success", startedAt: {$gte: since}, durationMs: {$exists: true}}},
                    {$group: {_id: null, avg: {$avg: "$durationMs"}}},
                ], opts),
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

    @action({auth: "private", schema: validateSingleForm})
    async previewNextRuns(params: Record<string, any>) {
        const {_id, company, logger, languageCode} = params;
        const job = await cronJobService.findOneOrThrow(
            {_id: new ObjectId(_id), company: company._id},
            {logger, languageCode},
        );
        return {nextRunsPreview: getNextRunsIso(job, 10)};
    }
}
