import {CronTime} from "cron";
import type {ICronJob} from "@coreModule/database/schemas/cronJob/cronJob";

type CronSchedule = Pick<ICronJob, "cronExpression">;

/**
 * Computes the next run time strictly after `from`, in UTC.
 */
export function computeNextRunAt(job: CronSchedule, from: Date = new Date()): Date | null {
    if (!job.cronExpression) return null;
    try {
        const ct = new CronTime(job.cronExpression, "UTC");
        return ct.getNextDateFrom(from).toJSDate();
    } catch {
        return null;
    }
}

export function getNextRuns(
    job: CronSchedule,
    count: number = 10,
    from: Date = new Date(),
): Date[] {
    const results: Date[] = [];
    let cursor = from;

    for (let i = 0; i < count; i++) {
        const next = computeNextRunAt(job, cursor);
        if (!next) break;
        if (next.getTime() <= cursor.getTime()) {
            cursor = new Date(cursor.getTime() + 1_000);
            continue;
        }
        results.push(next);
        cursor = next;
    }

    return results;
}

/**
 * How many schedule occurrences are due at or before `now`, starting from `nextRunAt`.
 * Caps at `max` so a long outage cannot walk an unbounded loop.
 */
export function countDueOccurrences(job: CronSchedule & {nextRunAt?: Date}, now: Date, max: number): number {
    if (!job.nextRunAt || job.nextRunAt.getTime() > now.getTime()) return 0;
    let count = 1;
    let cursor = job.nextRunAt;
    while (count < max) {
        const next = computeNextRunAt(job, cursor);
        if (!next || next.getTime() <= cursor.getTime()) break;
        if (next.getTime() > now.getTime()) break;
        count++;
        cursor = next;
    }
    return count;
}

export function getNextRunsIso(
    job: CronSchedule,
    count: number = 10,
): string[] {
    return getNextRuns(job, count).map(d => d.toISOString());
}
