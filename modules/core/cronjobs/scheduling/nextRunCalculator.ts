import {CronJob} from "cron";
import type {ICronJob, ICronJobInterval} from "@coreModule/database/schemas/cronJob/cronJob";

const UNIT_MS: Record<ICronJobInterval["unit"], number> = {
    seconds: 1_000,
    minutes: 60_000,
    hours: 3_600_000,
    days: 86_400_000,
};

function intervalToMs(interval: ICronJobInterval): number {
    return interval.value * UNIT_MS[interval.unit];
}

/**
 * Computes the next run time strictly after `from`.
 */
export function computeNextRunAt(job: Pick<ICronJob, "type" | "cronExpression" | "interval" | "timezone">, from: Date = new Date()): Date | null {
    const tz = job.timezone || "UTC";

    if (job.type === "once") {
        return from;
    }

    if (job.type === "interval" || job.type === "queue") {
        if (!job.interval) return null;
        return new Date(from.getTime() + intervalToMs(job.interval));
    }

    if (job.type === "cron" && job.cronExpression) {
        try {
            const cj = new CronJob(job.cronExpression, () => {}, null, false, tz);
            const next = cj.nextDate().toJSDate();
            if (next.getTime() <= from.getTime()) {
                cj.start();
                const n2 = cj.nextDate().toJSDate();
                cj.stop();
                return n2;
            }
            return next;
        } catch {
            return null;
        }
    }

    return null;
}

export function getNextRuns(
    job: Pick<ICronJob, "type" | "cronExpression" | "interval" | "timezone">,
    count: number = 10,
    from: Date = new Date(),
): Date[] {
    const results: Date[] = [];
    let cursor = from;

    if (job.type === "once") {
        return [from];
    }

    for (let i = 0; i < count; i++) {
        const next = computeNextRunAt(job, cursor);
        if (!next) break;
        if (job.type === "cron" && next.getTime() <= cursor.getTime()) {
            cursor = new Date(cursor.getTime() + 1_000);
            continue;
        }
        results.push(next);
        cursor = new Date(next.getTime() + 1);
    }

    return results;
}

export function getNextRunsIso(
    job: Pick<ICronJob, "type" | "cronExpression" | "interval" | "timezone">,
    count: number = 10,
): string[] {
    return getNextRuns(job, count).map(d => d.toISOString());
}
