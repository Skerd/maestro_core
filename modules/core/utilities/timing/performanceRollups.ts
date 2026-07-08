/**
 * Performance Rollups
 *
 * Cron-driven aggregations that collapse high-resolution time-series data into
 * coarser buckets so the admin UI can render historical charts efficiently.
 *
 * Pipeline:
 *   serverPerformance1m  --(hourly)-->  serverPerformance1h  --(daily)-->  serverPerformance1d
 *
 * Each rollup is idempotent: it groups by (method, endpoint, bucketStart) and
 * upserts into the target collection. Reservoirs are not preserved across rollups —
 * percentiles in the higher tiers are derived from a count-weighted average of the
 * source bucket percentiles, which is accurate enough for time-trend charts and
 * cheaper than re-merging samples.
 *
 * @module utilities/core/timing/performanceRollups
 */

import {CronJob} from "cron";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import ServerPerformance1m, {
    IServerPerformance1m
} from "@coreModule/database/schemas/performance/serverPerformance/serverPerformance1m";
import ServerPerformance1h, {
    IServerPerformance1h
} from "@coreModule/database/schemas/performance/serverPerformance/serverPerformance1h";
import ServerPerformance1d from "@coreModule/database/schemas/performance/serverPerformance/serverPerformance1d";

const ONE_HOUR_MS = 60 * 60 * 1_000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

/**
 * Rolls the previous hour of 1-minute buckets into a single 1-hour bucket per
 * (method, endpoint). Designed to run at HH:01 of every hour; rolls the
 * (HH-1):00 → HH:00 range to ensure all minute buckets in the source range
 * have been flushed by the aggregator (3s margin).
 */
async function runHourlyRollup(parentLogger?: serverLogger): Promise<void> {
    const log = getLogger("performance_rollup_1h", parentLogger);
    log.start("Running hourly rollup (1m -> 1h)");

    const now = Date.now();
    const hourStart = Math.floor(now / ONE_HOUR_MS) * ONE_HOUR_MS;
    const fromHour = hourStart - ONE_HOUR_MS;
    const toHour = hourStart;

    try {
        const docs: IServerPerformance1m[] = await ServerPerformance1m.aggregate([
            { $match: { bucketStart: { $gte: new Date(fromHour), $lt: new Date(toHour) } } },
            {
                $group: {
                    _id: { method: "$meta.method", endpoint: "$meta.endpoint" },
                    count: { $sum: "$count" },
                    errors: { $sum: "$errors" },
                    sum: { $sum: "$sum" },
                    sumSq: { $sum: "$sumSq" },
                    min: { $min: "$min" },
                    max: { $max: "$max" },
                    p50Weighted: { $sum: { $multiply: ["$p50", "$count"] } },
                    p95Weighted: { $sum: { $multiply: ["$p95", "$count"] } },
                    p99Weighted: { $sum: { $multiply: ["$p99", "$count"] } },
                    lastExecuted: { $max: "$lastExecuted" }
                }
            }
        ]).exec();

        if (docs.length === 0) {
            log.finish("No 1m buckets in the previous hour; nothing to roll up");
            return;
        }

        const targetBucket = new Date(fromHour);
        const inserts = docs.map((d: any) => ({
            insertOne: {
                document: {
                    bucketStart: targetBucket,
                    meta: { method: d._id.method, endpoint: d._id.endpoint },
                    count: d.count,
                    errors: d.errors,
                    sum: d.sum,
                    sumSq: d.sumSq,
                    min: d.min,
                    max: d.max,
                    p50: d.count === 0 ? 0 : Math.round(d.p50Weighted / d.count),
                    p95: d.count === 0 ? 0 : Math.round(d.p95Weighted / d.count),
                    p99: d.count === 0 ? 0 : Math.round(d.p99Weighted / d.count),
                    lastExecuted: d.lastExecuted
                }
            }
        }));

        if (inserts.length > 0) {
            await ServerPerformance1h.bulkWrite(inserts, { ordered: false });
        }
        log.finish(`Hourly rollup wrote ${inserts.length} buckets for window ${new Date(fromHour).toISOString()} -> ${new Date(toHour).toISOString()}`);
    }
    catch (err: any) {
        log.err(`Hourly rollup failed: ${err?.message}`);
    }
}

/**
 * Rolls the previous day of 1-hour buckets into a single 1-day bucket per
 * (method, endpoint). Designed to run at 00:05 of every day.
 */
async function runDailyRollup(parentLogger?: serverLogger): Promise<void> {
    const log = getLogger("performance_rollup_1d", parentLogger);
    log.start("Running daily rollup (1h -> 1d)");

    const now = Date.now();
    const dayStart = Math.floor(now / ONE_DAY_MS) * ONE_DAY_MS;
    const fromDay = dayStart - ONE_DAY_MS;
    const toDay = dayStart;

    try {
        const docs: IServerPerformance1h[] = await ServerPerformance1h.aggregate([
            { $match: { bucketStart: { $gte: new Date(fromDay), $lt: new Date(toDay) } } },
            {
                $group: {
                    _id: { method: "$meta.method", endpoint: "$meta.endpoint" },
                    count: { $sum: "$count" },
                    errors: { $sum: "$errors" },
                    sum: { $sum: "$sum" },
                    sumSq: { $sum: "$sumSq" },
                    min: { $min: "$min" },
                    max: { $max: "$max" },
                    p50Weighted: { $sum: { $multiply: ["$p50", "$count"] } },
                    p95Weighted: { $sum: { $multiply: ["$p95", "$count"] } },
                    p99Weighted: { $sum: { $multiply: ["$p99", "$count"] } },
                    lastExecuted: { $max: "$lastExecuted" }
                }
            }
        ]).exec();

        if (docs.length === 0) {
            log.finish("No 1h buckets in the previous day; nothing to roll up");
            return;
        }

        const targetBucket = new Date(fromDay);
        const inserts = docs.map((d: any) => ({
            insertOne: {
                document: {
                    bucketStart: targetBucket,
                    meta: { method: d._id.method, endpoint: d._id.endpoint },
                    count: d.count,
                    errors: d.errors,
                    sum: d.sum,
                    sumSq: d.sumSq,
                    min: d.min,
                    max: d.max,
                    p50: d.count === 0 ? 0 : Math.round(d.p50Weighted / d.count),
                    p95: d.count === 0 ? 0 : Math.round(d.p95Weighted / d.count),
                    p99: d.count === 0 ? 0 : Math.round(d.p99Weighted / d.count),
                    lastExecuted: d.lastExecuted
                }
            }
        }));

        if (inserts.length > 0) {
            await ServerPerformance1d.bulkWrite(inserts, { ordered: false });
        }
        log.finish(`Daily rollup wrote ${inserts.length} buckets for window ${new Date(fromDay).toISOString()} -> ${new Date(toDay).toISOString()}`);
    }
    catch (err: any) {
        log.err(`Daily rollup failed: ${err?.message}`);
    }
}

/**
 * Starts the hourly + daily rollup crons. Idempotent.
 *
 * Schedule:
 *  - Hourly: runs at minute 1 of every hour (HH:01).
 *  - Daily: runs at 00:05 every day.
 */
let hourlyJob: CronJob | null = null;
let dailyJob: CronJob | null = null;

export function startPerformanceRollupJobs(parentLogger?: serverLogger): void {
    const log = getLogger("performance_rollup_jobs", parentLogger);
    if (hourlyJob === null) {
        hourlyJob = new CronJob("0 1 * * * *", () => { void runHourlyRollup(parentLogger); }, null, true, "UTC");
        log.debug("Hourly performance rollup scheduled (cron: 0 1 * * * *)");
    }
    if (dailyJob === null) {
        dailyJob = new CronJob("0 5 0 * * *", () => { void runDailyRollup(parentLogger); }, null, true, "UTC");
        log.debug("Daily performance rollup scheduled (cron: 0 5 0 * * *)");
    }
}

export function stopPerformanceRollupJobs(): void {
    if (hourlyJob) { hourlyJob.stop(); hourlyJob = null; } 
    if (dailyJob) { dailyJob.stop(); dailyJob = null; }
}
