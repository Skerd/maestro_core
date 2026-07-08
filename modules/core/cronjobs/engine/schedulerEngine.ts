import CronJobModel from "@coreModule/database/schemas/cronJob/cronJob";
import type {ICronJob} from "@coreModule/database/schemas/cronJob/cronJob";
import {CRON} from "@coreModule/environment";
import {isKafkaConnected} from "@coreModule/connections/connectToKafka";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {computeNextRunAt} from "@coreModule/cronjobs/scheduling/nextRunCalculator";
import {
    publishSchedulerHeartbeat,
    releaseSchedulerLeader,
    tryAcquireSchedulerLeader,
    type DistributedLockHandle,
} from "@coreModule/cronjobs/locking/distributedLock";
import {renewRedisLock} from "@coreModule/cronjobs/locking/redisLock";
import {jobRunner} from "@coreModule/cronjobs/engine/jobRunner";
import {kafkaQueueAdapter} from "@coreModule/cronjobs/adapters/kafkaQueueAdapter";
import type {CronQueueMessage} from "@coreModule/cronjobs/adapters/queueAdapter";
import CronExecution from "@coreModule/database/schemas/cronExecution/cronExecution";
import {pruneStaleMongoLocks} from "@coreModule/cronjobs/locking/mongoLock";

export class SchedulerEngine {
    private tickTimer: NodeJS.Timeout | null = null;
    private healTimer: NodeJS.Timeout | null = null;
    private leaderHandle: DistributedLockHandle | null = null;
    private running = false;
    private readonly logger = getLogger("cron_scheduler");

    async start(parentLogger?: serverLogger): Promise<void> {
        if (this.running) return;
        this.running = true;
        const log = getLogger("cron_scheduler", parentLogger);
        log.debug("Scheduler engine starting");

        if (isKafkaConnected()) {
            await kafkaQueueAdapter.startConsumer(async (msg: CronQueueMessage) => {
                await jobRunner.runById(msg.jobId, {
                    attempt: msg.attempt,
                    executionId: msg.executionId,
                    parentLogger: log,
                });
            });
        } else {
            log.warn("Kafka not connected — queue execution strategy unavailable");
        }

        this.tickTimer = setInterval(() => void this.tick(log), CRON.SCHEDULER_TICK_MS);
        this.healTimer = setInterval(() => void this.selfHeal(log), CRON.SELF_HEAL_INTERVAL_MS);
        await this.tick(log);
    }

    async stop(): Promise<void> {
        this.running = false;
        if (this.tickTimer) clearInterval(this.tickTimer);
        if (this.healTimer) clearInterval(this.healTimer);
        this.tickTimer = null;
        this.healTimer = null;
        await jobRunner.awaitActiveRuns();
        await kafkaQueueAdapter.stopConsumer();
        if (this.leaderHandle) {
            await releaseSchedulerLeader(this.leaderHandle);
            this.leaderHandle = null;
        }
    }

    private async tick(log: serverLogger): Promise<void> {
        if (!this.running || !CRON.ENABLED) return;

        if (!this.leaderHandle) {
            this.leaderHandle = await tryAcquireSchedulerLeader();
            if (!this.leaderHandle) return;
        } else if (this.leaderHandle.redis) {
            const ok = await renewRedisLock(this.leaderHandle.redis, CRON.LEADER_LOCK_TTL_MS);
            if (!ok) {
                await releaseSchedulerLeader(this.leaderHandle);
                this.leaderHandle = null;
                return;
            }
        }

        await publishSchedulerHeartbeat();

        const now = new Date();
        const dueJobs = await CronJobModel.find({
            active: true,
            pausedAt: null,
            deletedAt: null,
            nextRunAt: {$lte: now},
        })
            .sort({priority: -1, nextRunAt: 1})
            .limit(CRON.SCHEDULER_BATCH_SIZE)
            .lean<ICronJob[]>();

        for (const job of dueJobs) {
            try {
                await this.dispatchJob(job as ICronJob, log, now);
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                log.err(`Dispatch failed for ${job.code}: ${msg}`);
            }
        }
    }

    private async dispatchJob(job: ICronJob, log: serverLogger, now: Date): Promise<void> {
        const nextRunAt = computeNextRunAt(job, now);
        if (nextRunAt) {
            await CronJobModel.updateOne({_id: job._id}, {$set: {nextRunAt}});
        }

        if (job.executionStrategy === "queue" || job.type === "queue") {
            if (!isKafkaConnected()) {
                log.warn(`Job ${job.code} uses queue strategy but Kafka is disconnected`);
                return;
            }
            const msg: CronQueueMessage = {
                jobId: job._id.toString(),
                attempt: 1,
                company: job.company?.toString() ?? null,
                handler: job.handler,
                metadata: job.metadata as Record<string, unknown> | undefined,
                enqueuedAt: new Date().toISOString(),
            };
            await kafkaQueueAdapter.enqueue(msg);
            return;
        }

        await jobRunner.runJob(job, {parentLogger: log});
    }

    private async selfHeal(log: serverLogger): Promise<void> {
        const graceMs = 120_000;
        const stuck = await CronExecution.find({
            status: "running",
            startedAt: {$lt: new Date(Date.now() - graceMs)},
        }).limit(100);

        for (const ex of stuck) {
            await CronExecution.updateOne(
                {_id: ex._id},
                {
                    $set: {
                        status: "timeout",
                        finishedAt: new Date(),
                        error: {message: "Stuck execution recovered by self-heal"},
                    },
                },
            );
            log.debug(`Healed stuck execution ${ex._id.toString()}`);
        }

        const orphaned = await CronJobModel.find({
            active: true,
            deletedAt: null,
            $or: [{nextRunAt: null}, {nextRunAt: {$exists: false}}],
        }).limit(50);

        for (const job of orphaned) {
            const next = computeNextRunAt(job, new Date());
            if (next) {
                await CronJobModel.updateOne({_id: job._id}, {$set: {nextRunAt: next}});
            }
        }

        await pruneStaleMongoLocks();
    }
}

export const schedulerEngine = new SchedulerEngine();
