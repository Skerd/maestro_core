import {Types} from "mongoose";
import {CRON} from "@coreModule/environment";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {getCronHandler} from "@coreModule/cronjobs/registry/handlerRegistry";
import type {CronHandlerFn} from "@coreModule/cronjobs/registry/types";
import {acquireCronLock, keepCronLockAlive, releaseCronLock} from "@coreModule/cronjobs/locking/distributedLock";
import {computeRetryDelayMs, resolveRunAttempt, shouldRetry} from "@coreModule/cronjobs/engine/retryEngine";
import {awaitHandlerWithTimeout} from "@coreModule/cronjobs/engine/awaitHandlerWithTimeout";
import {recordCronResult} from "@coreModule/cronjobs/health/cronSchedulerHealth";
import CronJobModel, {type ICronJob} from "@coreModule/database/schemas/cronJob/cronJob";
import CronExecution, {type CronExecutionStatus} from "@coreModule/database/schemas/cronExecution/cronExecution";

const MAX_LOG_LINES = 500;
/** CronJob schema default; rows saved before the field existed have none. */
export const DEFAULT_TIMEOUT_SECONDS = 300;

type RunOutcome = {
    status: CronExecutionStatus;
    error?: {message: string; stack?: string};
};

function errorMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

/**
 * Runs jobs inside the scheduler process. Concurrency is bounded globally, per
 * company, and to one run per job: a job that cannot start stays due, and the
 * scheduler offers it again on a later tick.
 */
export class JobRunner {
    private readonly active = new Set<Promise<void>>();
    private readonly runningJobs = new Set<string>();
    private readonly runningPerCompany = new Map<string, number>();

    hasCapacity(job: ICronJob): boolean {
        if (this.runningJobs.has(job._id.toString())) return false;
        if (this.runningJobs.size >= CRON.MAX_CONCURRENT_GLOBAL) return false;
        const companyRuns = this.runningPerCompany.get(String(job.company?._id)) ?? 0;
        return companyRuns < CRON.MAX_CONCURRENT_PER_COMPANY;
    }

    /** Starts `runs` back-to-back executions of `job` without waiting for them. Check `hasCapacity` first. */
    start(job: ICronJob, runs: number, parentLogger?: serverLogger): void {
        const logger = getLogger("cron_runner", parentLogger);
        const company: Types.ObjectId | undefined = job.company?._id;
        if (!company) {
            logger.warn(`Job ${job.code} skipped: it has no company`);
            return;
        }
        const jobId = job._id.toString();
        const companyKey = company.toString();
        this.runningJobs.add(jobId);
        this.runningPerCompany.set(companyKey, (this.runningPerCompany.get(companyKey) ?? 0) + 1);

        const run: Promise<void> = (async () => {
            for (let i = 0; i < runs; i++) {
                await this.runOnce(job, company, logger);
            }
        })()
            .catch((e: unknown) => logger.err(`Job ${job.code} crashed: ${errorMessage(e)}`))
            .finally(() => {
                this.runningJobs.delete(jobId);
                const left = (this.runningPerCompany.get(companyKey) ?? 1) - 1;
                if (left > 0) this.runningPerCompany.set(companyKey, left);
                else this.runningPerCompany.delete(companyKey);
                this.active.delete(run);
            });
        this.active.add(run);
    }

    /** Waits for running jobs to settle, up to `timeoutMs`. */
    async awaitActiveRuns(timeoutMs: number = CRON.GRACEFUL_SHUTDOWN_MS): Promise<void> {
        if (this.active.size === 0) return;
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
            Promise.allSettled([...this.active]),
            new Promise<void>((resolve) => {
                timer = setTimeout(resolve, timeoutMs);
            }),
        ]);
        clearTimeout(timer);
    }

    private async runOnce(job: ICronJob, company: Types.ObjectId, logger: serverLogger): Promise<void> {
        const registration = getCronHandler(job.handler);
        if (!registration) {
            logger.warn(`Job ${job.code} skipped: handler ${job.handler} is not registered`);
            return;
        }
        // Guards against the previous leader still running this job during a handover.
        const lock = await acquireCronLock(job._id.toString(), CRON.LOCK_TTL_MS);
        if (!lock) {
            logger.warn(`Job ${job.code} skipped: another instance holds its lock`);
            return;
        }
        const stopRenewing = keepCronLockAlive(lock);
        try {
            await this.execute(job, company, registration.handler, logger);
        } finally {
            stopRenewing();
            await releaseCronLock(lock);
        }
    }

    private async execute(job: ICronJob, company: Types.ObjectId, handler: CronHandlerFn, logger: serverLogger): Promise<void> {
        const last = await CronExecution.findOne({jobId: job._id})
            .sort({startedAt: -1})
            .select("status attempt nextRetryAt")
            .lean();
        const attempt = resolveRunAttempt(last);
        const execution = await CronExecution.create({
            jobId: job._id,
            company,
            status: "running",
            startedAt: new Date(),
            serverId: CRON.SERVER_ID,
            attempt,
        });

        const logs: string[] = [];
        const appendLog = (line: string) => {
            logs.push(`${new Date().toISOString()} ${line}`);
            if (logs.length > MAX_LOG_LINES) logs.shift();
        };
        appendLog(`Starting handler ${job.handler} attempt ${attempt}`);

        const timeoutSeconds = job.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
        const controller = new AbortController();
        let outcome: RunOutcome;
        try {
            await awaitHandlerWithTimeout(
                handler({job, execution, company, logger, signal: controller.signal, appendLog}),
                controller,
                timeoutSeconds * 1_000,
                `Job timed out after ${timeoutSeconds}s`,
            );
            outcome = {status: "success"};
            appendLog("Handler completed successfully");
        } catch (e: unknown) {
            outcome = controller.signal.aborted
                ? {status: "timeout", error: {message: `Job timed out after ${timeoutSeconds}s`}}
                : {status: "failed", error: {message: errorMessage(e), stack: e instanceof Error ? e.stack : undefined}};
            appendLog(`Handler failed: ${outcome.error?.message}`);
        }

        const finishedAt = new Date();
        const durationMs = finishedAt.getTime() - execution.startedAt.getTime();
        recordCronResult(outcome.status === "success" ? "completed" : "failed", durationMs);

        const retryAt = outcome.status !== "success" && shouldRetry(attempt, job.maxRetries)
            ? new Date(finishedAt.getTime() + computeRetryDelayMs(job, attempt))
            : null;
        await CronExecution.updateOne(
            {_id: execution._id},
            {
                $set: {
                    status: outcome.status,
                    finishedAt,
                    durationMs,
                    logs,
                    ...(outcome.error ? {error: outcome.error} : {}),
                    ...(retryAt ? {nextRetryAt: retryAt} : {}),
                },
            },
        );
        // The scheduler already moved nextRunAt to the next occurrence; a retry can only pull it earlier.
        await CronJobModel.updateOne(
            {_id: job._id},
            {
                $set: {lastRunAt: finishedAt},
                ...(retryAt ? {$min: {nextRunAt: retryAt}} : {}),
            },
        );
    }
}

export const jobRunner = new JobRunner();
