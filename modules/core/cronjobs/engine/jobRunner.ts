import os from "os";
import {Types} from "mongoose";
import {CRON} from "@coreModule/environment";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {getCronHandlerFn} from "@coreModule/cronjobs/registry/handlerRegistry";
import {computeNextRunAt} from "@coreModule/cronjobs/scheduling/nextRunCalculator";
import {acquireJobLock, releaseJobLock} from "@coreModule/cronjobs/locking/distributedLock";
import {computeRetryDelayMs, shouldRetry} from "@coreModule/cronjobs/engine/retryEngine";
import {cronJobService} from "@coreModule/database/schemas/cronJob/cronJob.service";
import {cronExecutionService} from "@coreModule/database/schemas/cronExecution/cronExecution.service";
import type {ICronJob} from "@coreModule/database/schemas/cronJob/cronJob";
import type {ICronExecution, CronExecutionStatus} from "@coreModule/database/schemas/cronExecution/cronExecution";
import CronExecution from "@coreModule/database/schemas/cronExecution/cronExecution";
import {recordCronResult} from "@coreModule/cronjobs/health/cronSchedulerHealth";

const MAX_LOG_LINES = 500;

let globalRunning = 0;
const companyRunning = new Map<string, number>();
const jobRunning = new Map<string, number>();

const activeExecutions = new Set<string>();

function serverId(): string {
    return `${os.hostname()}:${process.pid}`;
}

function canAcquireConcurrency(job: ICronJob): boolean {
    if (globalRunning >= CRON.MAX_CONCURRENT_GLOBAL) return false;
    const companyKey = job.company?.toString() ?? "__global__";
    const companyCount = companyRunning.get(companyKey) ?? 0;
    if (companyCount >= CRON.MAX_CONCURRENT_PER_COMPANY) return false;
    const jobCount = jobRunning.get(job._id.toString()) ?? 0;
    const maxJob = job.maxConcurrentRuns ?? (job.allowParallelRuns ? 10 : 1);
    if (jobCount >= maxJob) return false;
    return true;
}

function incrementConcurrency(job: ICronJob): void {
    globalRunning++;
    const companyKey = job.company?.toString() ?? "__global__";
    companyRunning.set(companyKey, (companyRunning.get(companyKey) ?? 0) + 1);
    jobRunning.set(job._id.toString(), (jobRunning.get(job._id.toString()) ?? 0) + 1);
}

function decrementConcurrency(job: ICronJob): void {
    globalRunning = Math.max(0, globalRunning - 1);
    const companyKey = job.company?.toString() ?? "__global__";
    const c = (companyRunning.get(companyKey) ?? 1) - 1;
    if (c <= 0) companyRunning.delete(companyKey);
    else companyRunning.set(companyKey, c);
    const j = (jobRunning.get(job._id.toString()) ?? 1) - 1;
    if (j <= 0) jobRunning.delete(job._id.toString());
    else jobRunning.set(job._id.toString(), j);
}

export type RunJobOptions = {
    manual?: boolean;
    attempt?: number;
    parentLogger?: serverLogger;
    executionId?: string;
};

export class JobRunner {
    async runById(jobId: string, options: RunJobOptions = {}): Promise<ICronExecution | null> {
        const job = await cronJobService.findById(jobId, {
            logger: getLogger("cron_runner"),
            languageCode: "en-US",
        });
        if (!job) return null;
        return this.runJob(job, options);
    }

    async runJob(job: ICronJob, options: RunJobOptions = {}): Promise<ICronExecution | null> {
        const logger = getLogger("cron_runner", options.parentLogger);
        if (!job.active || job.pausedAt) {
            logger.debug(`Job ${job.code} skipped (inactive or paused)`);
            return null;
        }
        if (!canAcquireConcurrency(job)) {
            logger.debug(`Job ${job.code} skipped (concurrency limit)`);
            return null;
        }

        const attempt = options.attempt ?? 1;
        const needsLock = job.singleton || job.executionStrategy === "distributed" || !job.allowParallelRuns;

        let execution = options.executionId
            ? await cronExecutionService.findById(options.executionId, {logger, languageCode: "en-US"})
            : null;

        if (!execution) {
            execution = await CronExecution.create({
                jobId: job._id,
                company: job.company ?? null,
                status: "running",
                startedAt: new Date(),
                serverId: serverId(),
                attempt,
                metadata: {manual: !!options.manual},
            });
        }

        activeExecutions.add(execution._id.toString());
        incrementConcurrency(job);

        let lock = null;
        if (needsLock) {
            lock = await acquireJobLock(
                job._id.toString(),
                job.allowParallelRuns ? execution._id.toString() : undefined,
            );
            if (!lock) {
                await this.finalizeExecution(execution._id, "cancelled", {
                    message: "Could not acquire distributed lock",
                });
                decrementConcurrency(job);
                activeExecutions.delete(execution._id.toString());
                return execution;
            }
        }

        const logs: string[] = [];
        const appendLog = (line: string) => {
            logs.push(`${new Date().toISOString()} ${line}`);
            if (logs.length > MAX_LOG_LINES) logs.shift();
        };

        const timeoutMs = (job.timeoutSeconds ?? 300) * 1_000;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        let status: CronExecutionStatus = "success";
        let error: {message: string; stack?: string} | undefined;

        try {
            const handler = getCronHandlerFn(job.handler);
            appendLog(`Starting handler ${job.handler} attempt ${attempt}`);
            await handler({
                job,
                execution,
                company: job.company ?? null,
                logger,
                signal: controller.signal,
                metadata: (job.metadata as Record<string, unknown>) ?? {},
                appendLog,
            });
            appendLog("Handler completed successfully");
        } catch (e: unknown) {
            if (controller.signal.aborted) {
                status = "timeout";
                error = {message: `Job timed out after ${job.timeoutSeconds ?? 300}s`};
            } else {
                status = "failed";
                error = {
                    message: e instanceof Error ? e.message : String(e),
                    stack: e instanceof Error ? e.stack : undefined,
                };
            }
            appendLog(`Handler failed: ${error.message}`);
        } finally {
            clearTimeout(timeout);
            if (lock) await releaseJobLock(lock);
        }

        const finishedAt = new Date();
        const durationMs = finishedAt.getTime() - execution.startedAt.getTime();

        // Surface throughput on the server-health card (same process that
        // publishes the scheduler heartbeat when it holds leadership).
        recordCronResult(status === "success" ? "completed" : "failed", durationMs);

        await CronExecution.updateOne(
            {_id: execution._id},
            {
                $set: {
                    status,
                    finishedAt,
                    durationMs,
                    logs,
                    error,
                },
            },
        );

        if (status === "success") {
            const nextRunAt = job.type === "once" ? null : computeNextRunAt(job, finishedAt);
            await cronJobService.updateById(
                job._id,
                {
                    $set: {
                        lastRunAt: finishedAt,
                        ...(nextRunAt ? {nextRunAt} : {}),
                        ...(job.type === "once" ? {active: false} : {}),
                    },
                },
                {logger, languageCode: "en-US"},
            );
        } else if (shouldRetry(attempt, job.maxRetries)) {
            const delayMs = computeRetryDelayMs(job, attempt);
            const nextRetryAt = new Date(Date.now() + delayMs);
            await CronExecution.updateOne(
                {_id: execution._id},
                {$set: {nextRetryAt}},
            );
            const nextRunAt = computeNextRunAt(
                {...job, type: "interval", interval: {value: Math.ceil(delayMs / 1_000), unit: "seconds"}},
                new Date(),
            );
            if (nextRunAt) {
                await cronJobService.updateById(
                    job._id,
                    {$set: {nextRunAt}},
                    {logger, languageCode: "en-US"},
                );
            }
        } else {
            const nextRunAt = computeNextRunAt(job, finishedAt);
            if (nextRunAt) {
                await cronJobService.updateById(
                    job._id,
                    {$set: {lastRunAt: finishedAt, nextRunAt}},
                    {logger, languageCode: "en-US"},
                );
            }
        }

        decrementConcurrency(job);
        activeExecutions.delete(execution._id.toString());

        return (await cronExecutionService.findById(execution._id.toString(), {
            logger,
            languageCode: "en-US",
        })) as ICronExecution;
    }

    private async finalizeExecution(
        executionId: Types.ObjectId,
        status: CronExecutionStatus,
        error?: {message: string; stack?: string},
    ): Promise<void> {
        await CronExecution.updateOne(
            {_id: executionId},
            {
                $set: {
                    status,
                    finishedAt: new Date(),
                    error,
                },
            },
        );
    }

    async awaitActiveRuns(timeoutMs: number = CRON.GRACEFUL_SHUTDOWN_MS): Promise<void> {
        const start = Date.now();
        while (activeExecutions.size > 0 && Date.now() - start < timeoutMs) {
            await new Promise(r => setTimeout(r, 500));
        }
    }

    getActiveCount(): number {
        return activeExecutions.size;
    }
}

export const jobRunner = new JobRunner();
