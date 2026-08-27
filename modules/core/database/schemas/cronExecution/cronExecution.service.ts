import {Types} from "mongoose";
import {BaseCrudService, type CrudOptions} from "@coreModule/database/services/baseCrudService";
import CronExecution, {ICronExecution} from "@coreModule/database/schemas/cronExecution/cronExecution";

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
}

export const cronExecutionService = new CronExecutionService();
