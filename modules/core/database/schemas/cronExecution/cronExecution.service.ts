import {Types} from "mongoose";
import {BaseCrudService, type CrudOptions} from "@coreModule/database/services/baseCrudService";
import CronExecution, {type CronExecutionStatus, ICronExecution} from "@coreModule/database/schemas/cronExecution/cronExecution";

type LatestExecutionRow = {_id: Types.ObjectId; doc: ICronExecution};

class CronExecutionService extends BaseCrudService<ICronExecution, typeof CronExecution> {
    constructor() {
        super(CronExecution, "CronExecution");
    }

    async latestByJobIds(
        jobIds: Types.ObjectId[],
        companyId: Types.ObjectId,
        options: CrudOptions = {},
    ): Promise<Map<string, ICronExecution>> {
        const map = new Map<string, ICronExecution>();
        if (jobIds.length === 0) return map;
        const rows = await this.aggregate([
            {$match: {jobId: {$in: jobIds}, company: companyId}},
            {$sort: {startedAt: -1}},
            {$group: {_id: "$jobId", doc: {$first: "$$ROOT"}}},
        ], options) as LatestExecutionRow[];
        for (const row of rows) {
            map.set(row._id.toString(), row.doc);
        }
        return map;
    }

    /** The job's latest execution, for the retry decision. */
    async findLatestForJob(jobId: Types.ObjectId) {
        return this.model.findOne({jobId})
            .sort({startedAt: -1})
            .select("status attempt nextRetryAt")
            .lean();
    }

    /** Opens a "running" execution. */
    async start(execution: {jobId: Types.ObjectId; company: Types.ObjectId; startedAt: Date; serverId: string; attempt: number}): Promise<ICronExecution> {
        return this.model.create({...execution, status: "running"});
    }

    /** Closes an execution with its outcome. */
    async finish(executionId: Types.ObjectId, outcome: {
        status: CronExecutionStatus;
        finishedAt: Date;
        durationMs: number;
        logs: string[];
        error?: {message: string; stack?: string};
        nextRetryAt?: Date | null;
    }): Promise<void> {
        const {error, nextRetryAt, ...rest} = outcome;
        await this.model.updateOne(
            {_id: executionId},
            {$set: {...rest, ...(error ? {error} : {}), ...(nextRetryAt ? {nextRetryAt} : {})}},
        );
    }

    /** Executions still "running" that started before `startedBefore` (self-heal candidates). */
    async findRunningSince(startedBefore: Date, limit: number) {
        return this.model.find({status: "running", startedAt: {$lt: startedBefore}})
            .select("jobId startedAt")
            .limit(limit)
            .lean();
    }

    /** Closes abandoned executions as timeouts. */
    async markTimedOut(executionIds: Types.ObjectId[], message: string): Promise<void> {
        await this.model.updateMany(
            {_id: {$in: executionIds}, status: "running"},
            {$set: {status: "timeout", finishedAt: new Date(), error: {message}}},
        );
    }
}

export const cronExecutionService = new CronExecutionService();
