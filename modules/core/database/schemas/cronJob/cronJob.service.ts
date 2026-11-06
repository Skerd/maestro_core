import type {ClientSession, Types} from "mongoose";
import {BaseCrudService} from "@coreModule/database/services/baseCrudService";
import CronJob, {ICronJob} from "@coreModule/database/schemas/cronJob/cronJob";

class CronJobService extends BaseCrudService<ICronJob, typeof CronJob> {
    constructor() {
        super(CronJob, "CronJob");
    }

    /** The scheduler's batch: active, unpaused jobs due by `now` that match one of the `runnable` clauses. */
    async findDue(runnable: Record<string, unknown>[], now: Date, limit: number): Promise<ICronJob[]> {
        return this.model.find({active: true, pausedAt: null, nextRunAt: {$lte: now}, $or: runnable})
            .noDeleted()
            .sort({priority: -1, nextRunAt: 1})
            .limit(limit)
            .lean<ICronJob[]>();
    }

    /**
     * Moves the job's nextRunAt from the value the scheduler read to `nextRunAt` (unset when none). False when
     * another leader moved it first, so an occurrence is claimed once.
     */
    async claimOccurrence(job: Pick<ICronJob, "_id" | "nextRunAt">, nextRunAt: Date | null): Promise<boolean> {
        const result = await this.model.updateOne(
            {_id: job._id, nextRunAt: job.nextRunAt},
            nextRunAt ? {$set: {nextRunAt}} : {$unset: {nextRunAt: ""}},
        );
        return result.modifiedCount > 0;
    }

    /** Active jobs without a nextRunAt (self-heal gives them one). */
    async findUnscheduled(limit: number): Promise<ICronJob[]> {
        return this.model.find({active: true, nextRunAt: null})
            .noDeleted()
            .select("cronExpression")
            .limit(limit)
            .lean<ICronJob[]>();
    }

    async setNextRunAt(jobId: Types.ObjectId, nextRunAt: Date): Promise<void> {
        await this.model.updateOne({_id: jobId}, {$set: {nextRunAt}});
    }

    /** Each job's own timeout (self-heal judges stuck executions by it). */
    async findTimeouts(jobIds: Types.ObjectId[]): Promise<ICronJob[]> {
        return this.model.find({_id: {$in: jobIds}}).select("timeoutSeconds").lean<ICronJob[]>();
    }

    /** After a run: records when it finished; a retry can only pull the next run earlier. */
    async recordRun(jobId: Types.ObjectId, finishedAt: Date, retryAt: Date | null): Promise<void> {
        await this.model.updateOne(
            {_id: jobId},
            {
                $set: {lastRunAt: finishedAt},
                ...(retryAt ? {$min: {nextRunAt: retryAt}} : {}),
            },
        );
    }

    /** Codes of the company's job rows among `codes` (seeding skips them). */
    async existingCodes(companyId: Types.ObjectId, codes: string[], session?: ClientSession | null): Promise<Set<string>> {
        const rows = await this.model.find({company: companyId, code: {$in: codes}}, "code", session ? {session} : {})
            .lean<Pick<ICronJob, "code">[]>();
        return new Set(rows.map((job) => job.code));
    }

    /** Inserts one seeded job row. */
    async insertSeeded(job: Record<string, unknown>, session?: ClientSession | null): Promise<void> {
        await this.model.create([job], session ? {session} : {});
    }

    /** The company's jobs of these handlers whose next run is already past. */
    async findOverdue(companyId: Types.ObjectId, handlers: string[], now: Date, session?: ClientSession | null): Promise<ICronJob[]> {
        return this.model.find({company: companyId, handler: {$in: handlers}, nextRunAt: {$lt: now}}).session(session ?? null);
    }

    /** Retires the rows from before jobs were seeded per company: they have no company to scope their work to. */
    async deactivateOwnerless(): Promise<void> {
        await this.model.updateMany({company: null, active: true}, {$set: {active: false}});
    }
}

export const cronJobService = new CronJobService();
