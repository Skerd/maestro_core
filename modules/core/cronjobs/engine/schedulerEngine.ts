import CronJobModel, {type ICronJob} from "@coreModule/database/schemas/cronJob/cronJob";
import CronExecution from "@coreModule/database/schemas/cronExecution/cronExecution";
import {CRON} from "@coreModule/environment";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {computeNextRunAt, countDueOccurrences} from "@coreModule/cronjobs/scheduling/nextRunCalculator";
import {acquireCronLock, releaseCronLock, renewCronLock, type CronLockHandle} from "@coreModule/cronjobs/locking/distributedLock";
import {listCronHandlerRegistrations} from "@coreModule/cronjobs/registry/handlerRegistry";
import {publishSchedulerHeartbeat} from "@coreModule/cronjobs/health/cronSchedulerHealth";
import {DEFAULT_TIMEOUT_SECONDS, jobRunner} from "@coreModule/cronjobs/engine/jobRunner";
import {CATCH_UP_MAX, selectRunCount} from "@coreModule/cronjobs/engine/missedRunPolicy";

/** Extra time past a job's own timeout before a "running" execution counts as abandoned. */
const STUCK_GRACE_MS = 120_000;

function errorMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

/**
 * One instance at a time holds the leader lock. Each tick, the leader claims
 * due jobs (moving nextRunAt to the next occurrence) and runs them in-process
 * through the job runner. Self-heal also runs on the leader.
 */
export class SchedulerEngine {
    private tickTimer: NodeJS.Timeout | null = null;
    private leader: CronLockHandle | null = null;
    private ticking = false;
    private lastHealAt = 0;

    async start(parentLogger?: serverLogger): Promise<void> {
        if (this.tickTimer) return;
        const log = getLogger("cron_scheduler", parentLogger);
        log.debug("Scheduler engine starting");
        this.tickTimer = setInterval(() => void this.tick(log), CRON.SCHEDULER_TICK_MS);
        await this.tick(log);
    }

    async stop(): Promise<void> {
        if (this.tickTimer) clearInterval(this.tickTimer);
        this.tickTimer = null;
        await jobRunner.awaitActiveRuns();
        if (this.leader) {
            await releaseCronLock(this.leader);
            this.leader = null;
        }
    }

    /** Never throws: a failed tick is logged and the next one tries again. Ticks never overlap. */
    private async tick(log: serverLogger): Promise<void> {
        if (this.ticking || !this.tickTimer || !CRON.ENABLED) return;
        this.ticking = true;
        try {
            if (!(await this.holdLeadership())) return;
            await publishSchedulerHeartbeat();
            await this.runDueJobs(log);
            if (Date.now() - this.lastHealAt >= CRON.SELF_HEAL_INTERVAL_MS) {
                this.lastHealAt = Date.now();
                await this.selfHeal(log);
            }
        } catch (e: unknown) {
            log.err(`Scheduler tick failed: ${errorMessage(e)}`);
        } finally {
            this.ticking = false;
        }
    }

    /** Renews leadership, or takes it when free. False while another instance leads. */
    private async holdLeadership(): Promise<boolean> {
        if (this.leader && await renewCronLock(this.leader)) return true;
        this.leader = await acquireCronLock("leader", CRON.LEADER_LOCK_TTL_MS);
        return this.leader !== null;
    }

    private async runDueJobs(log: serverLogger): Promise<void> {
        const now = new Date();
        const dueJobs = await CronJobModel.find({
            active: true,
            pausedAt: null,
            nextRunAt: {$lte: now},
            // Jobs of a module that is disabled on this deployment have no handler here.
            handler: {$in: listCronHandlerRegistrations().map((r) => r.code)},
        }).noDeleted()
            .sort({priority: -1, nextRunAt: 1})
            .limit(CRON.SCHEDULER_BATCH_SIZE)
            .lean<ICronJob[]>();

        for (const job of dueJobs) {
            if (!this.tickTimer) return;
            // A job still running, or over the concurrency limits, stays due. Occurrences
            // it misses meanwhile are judged by its missed-run policy once it can start.
            if (!jobRunner.hasCapacity(job)) continue;
            const runs = await this.claim(job, now, log);
            if (runs > 0) {
                jobRunner.start(job, runs, log);
            }
        }
    }

    /**
     * Moves nextRunAt past `now` and returns how many runs are owed under the
     * missed-run policy. The update matches the nextRunAt that was read, so an
     * occurrence is claimed once even if two leaders briefly overlap.
     */
    private async claim(job: ICronJob, now: Date, log: serverLogger): Promise<number> {
        const nextRunAt = computeNextRunAt(job, now);
        const result = await CronJobModel.updateOne(
            {_id: job._id, nextRunAt: job.nextRunAt},
            nextRunAt ? {$set: {nextRunAt}} : {$unset: {nextRunAt: ""}},
        );
        if (result.modifiedCount === 0) return 0;

        const due = countDueOccurrences(job, now, CATCH_UP_MAX);
        const runs = selectRunCount(job.missedRunPolicy, due);
        if (runs === 0) {
            log.debug(`Skipped ${due} missed run(s) of ${job.code} (missedRunPolicy=${job.missedRunPolicy})`);
        }
        return runs;
    }

    private async selfHeal(log: serverLogger): Promise<void> {
        await this.recoverStuckExecutions(log);

        // A job left without nextRunAt (for example one saved before scheduling existed) gets one.
        const unscheduled = await CronJobModel.find({active: true, nextRunAt: null})
            .noDeleted()
            .select("cronExpression")
            .limit(50)
            .lean<ICronJob[]>();
        for (const job of unscheduled) {
            const next = computeNextRunAt(job, new Date());
            if (next) {
                await CronJobModel.updateOne({_id: job._id}, {$set: {nextRunAt: next}});
            }
        }
    }

    /**
     * The runner always records an outcome, at the latest when the job's timeout
     * fires. An execution still "running" well past that timeout belongs to a
     * process that died, so it is closed as a timeout.
     */
    private async recoverStuckExecutions(log: serverLogger): Promise<void> {
        const now = Date.now();
        const candidates = await CronExecution.find({
            status: "running",
            startedAt: {$lt: new Date(now - STUCK_GRACE_MS)},
        }).select("jobId startedAt").limit(100).lean();
        if (candidates.length === 0) return;

        const jobs = await CronJobModel.find({_id: {$in: candidates.map((c) => c.jobId)}})
            .select("timeoutSeconds")
            .lean<ICronJob[]>();
        const timeoutMsById = new Map(
            jobs.map((j) => [j._id.toString(), (j.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1_000]),
        );
        const stuckIds = candidates
            .filter((c) => {
                const timeoutMs = timeoutMsById.get(c.jobId.toString()) ?? DEFAULT_TIMEOUT_SECONDS * 1_000;
                return c.startedAt.getTime() + timeoutMs + STUCK_GRACE_MS < now;
            })
            .map((c) => c._id);
        if (stuckIds.length === 0) return;

        await CronExecution.updateMany(
            {_id: {$in: stuckIds}, status: "running"},
            {$set: {status: "timeout", finishedAt: new Date(), error: {message: "Stuck execution recovered by self-heal"}}},
        );
        log.warn(`Recovered ${stuckIds.length} stuck cron execution(s)`);
    }
}

export const schedulerEngine = new SchedulerEngine();
