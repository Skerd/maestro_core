import {Schema} from "mongoose";
import {CRON} from "@coreModule/environment";

export function applyCronExecutionIndexes(schema: Schema): void {
    schema.index({jobId: 1, startedAt: -1});
    schema.index({company: 1, status: 1, startedAt: -1});
    schema.index({status: 1, startedAt: -1});
    const retentionDays = CRON.EXECUTION_RETENTION_DAYS;
    if (retentionDays > 0) {
        schema.index(
            {finishedAt: 1},
            {expireAfterSeconds: retentionDays * 24 * 60 * 60, partialFilterExpression: {finishedAt: {$exists: true}}},
        );
    }
}
