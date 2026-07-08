/**
 * Server Health History
 *
 * Writes per-minute health snapshots to `serverHealth1m` and rolls them up
 * to `serverHealth1h` and `serverHealth1d`. Owned by the WebSocket server
 * process so the snapshot source of truth (`getHealthData`) and the
 * persistence loop are co-located, avoiding the need for a second consumer
 * pipeline.
 *
 * Sampling model:
 *  - Every minute (cron `0 * * * * *`) we sample the current health envelope.
 *  - Each service produces one document with a connected/disconnected flag,
 *    its circuit breaker state, and DELTA values for completedJobs / failedJobs
 *    (computed against the previous tick's snapshot). Delta-based metrics
 *    let us answer "how many jobs failed in this minute?" via simple sums in
 *    the rollup; the cumulative counters live in the service counters layer.
 *
 * Aggregation model:
 *  - Hourly (cron `0 1 * * * *`): collapse 60 1m rows per service into one
 *    1h row with uptimePct = upSamples/samples and weighted averageTime.
 *  - Daily (cron `0 5 0 * * *`): collapse 24 1h rows per service into one
 *    1d row.
 *
 * Rationale for sample-based uptime calculation:
 *  - Sampling once per minute gives 1440 data points per day per service.
 *    For SLO purposes that's ~99.93% precision, well below the noise floor
 *    of any realistic SLA target.
 *  - Avoids the need for a write per state-change which would couple the
 *    snapshot code to the lifecycle of every connection.
 *
 * @module utilities/core/timing/serverHealthHistory 
 */

import {CronJob} from "cron";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {
    ServerHealthFormResponseType
} from "armonia/src/modules/core/api/auxiliary/private/serverHealth/serverHealth.dto";
import ServerHealth1m, {
    IServerHealth1m,
    ServerHealthServiceName
} from "@coreModule/database/schemas/performance/serverHealth/serverHealth1m";
import ServerHealth1h, {IServerHealth1h} from "@coreModule/database/schemas/performance/serverHealth/serverHealth1h";
import ServerHealth1d from "@coreModule/database/schemas/performance/serverHealth/serverHealth1d";

const ONE_HOUR_MS = 60 * 60 * 1_000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

type CounterPrev = {
    completed: number;
    failed: number;
    totalTime: number;
};

/**
 * Last-tick cumulative counters per service. Used to compute deltas for the
 * current minute. Initialized lazily on first tick; subsequent ticks emit
 * non-zero deltas only when the relevant service made progress.
 */
const lastCounters: Partial<Record<ServerHealthServiceName, CounterPrev>> = {};

let snapshotJob: CronJob | null = null;
let hourlyJob: CronJob | null = null;
let dailyJob: CronJob | null = null;

/**
 * Pulls per-service snapshot data from the unified health envelope.
 * Services without job counters (mongoDb, telegram) produce zero deltas
 * but are still represented for uptime reporting.
 */
function extractSnapshots(health: ServerHealthFormResponseType): {
    name: ServerHealthServiceName;
    connected: boolean;
    circuitBreakerState: "CLOSED" | "OPEN" | "HALF_OPEN";
    completed: number;
    failed: number;
    totalTime: number;
}[] {
    const services = health.services;
    if (!services) return [];

    return [
        {
            name: "mongoDb",
            connected: services.mongoDb.connected,
            circuitBreakerState: services.mongoDb.circuitBreaker.state,
            // Mongo's health envelope doesn't expose op-level counters; the
            // mongoDbCounter is reserved for future use.
            completed: 0,
            failed: 0,
            totalTime: 0
        },
        {
            name: "redis",
            connected: services.redis.connected,
            circuitBreakerState: services.redis.circuitBreaker.state,
            completed: services.redis.completedJobs,
            failed: services.redis.failedJobs,
            totalTime: services.redis.totalTime
        },
        {
            name: "kafka",
            connected: services.kafka.connected,
            circuitBreakerState: services.kafka.circuitBreaker.state,
            completed: services.kafka.completedJobs,
            failed: services.kafka.failedJobs,
            totalTime: services.kafka.totalTime
        },
        {
            name: "websocket",
            connected: services.websocket.connected,
            circuitBreakerState: services.websocket.circuitBreaker.state,
            // For the WS service we treat sent messages as completed jobs.
            completed: services.websocket.messages,
            failed: 0,
            totalTime: 0
        },
        {
            name: "telegram",
            connected: services.telegram.connected,
            circuitBreakerState: services.telegram.circuitBreaker.state,
            // Telegram tracks sent messages similarly to WS.
            completed: services.telegram.messages,
            failed: 0,
            totalTime: 0
        }
    ];
}

/**
 * Captures one minute of per-service health into `serverHealth1m`.
 *
 * The tick runs at the top of every minute. We anchor the bucket to the
 * NEXT-TO-LAST minute boundary so all `_*Counter.flush()` calls in the
 * previous minute have had time to land in Redis.
 *
 * No-op until the first tick has populated `lastCounters` (delta-based
 * metrics are meaningless on the first sample).
 */
async function takeHealthSnapshot(
    fetchHealth: () => Promise<ServerHealthFormResponseType>,
    parentLogger?: serverLogger
): Promise<void> {
    const log = getLogger("server_health_snapshot", parentLogger);
    try {
        const health = await fetchHealth();
        const samples = extractSnapshots(health);

        // Anchor the row at the start of the minute that just closed, so the
        // bucket label matches the rollup join window.
        const now = Date.now();
        const bucketStart = new Date(Math.floor(now / 60_000) * 60_000 - 60_000);

        const docs: IServerHealth1m[] = [];
        for (const s of samples) {
            const prev = lastCounters[s.name];
            const dC = prev ? Math.max(s.completed - prev.completed, 0) : 0;
            const dF = prev ? Math.max(s.failed - prev.failed, 0) : 0;
            const dT = prev ? Math.max(s.totalTime - prev.totalTime, 0) : 0;
            const ops = dC + dF;
            const avgTime = ops > 0 ? Math.round(dT / ops) : 0;

            // Always update lastCounters even if prev is undefined so the
            // next tick can compute non-zero deltas.
            lastCounters[s.name] = {
                completed: s.completed,
                failed: s.failed,
                totalTime: s.totalTime
            };

            // Skip the very first sample after process start. Without a prior
            // counter snapshot the deltas we'd write are meaningless and
            // would corrupt the hourly aggregates with one inflated zero row.
            if (!prev) continue;

            docs.push({
                bucketStart,
                meta: {service: s.name},
                up: s.connected ? 1 : 0,
                circuitBreakerState: s.circuitBreakerState,
                completedJobsDelta: dC,
                failedJobsDelta: dF,
                averageTime: avgTime
            });
        }

        if (docs.length > 0) {
            await ServerHealth1m.insertMany(docs, {ordered: false});
        }
    }
    catch (err: any) {
        log.err(`Failed to take health snapshot: ${err?.message}`);
    }
}

/**
 * Rolls the previous closed hour of `serverHealth1m` rows into a single
 * `serverHealth1h` row per service. Idempotent inserts: the rollup is
 * write-once so re-running on the same window writes a duplicate row;
 * the cron schedule (HH:01) pairs with the per-minute snapshotter to
 * avoid this in steady state.
 */
async function runHourlyRollup(parentLogger?: serverLogger): Promise<void> {
    const log = getLogger("server_health_rollup_1h", parentLogger);
    log.start("Running hourly rollup (serverHealth1m -> serverHealth1h)");

    const now = Date.now();
    const hourStart = Math.floor(now / ONE_HOUR_MS) * ONE_HOUR_MS;
    const fromHour = hourStart - ONE_HOUR_MS;
    const toHour = hourStart;

    try {
        const docs: any[] = await ServerHealth1m.aggregate([
            {$match: {bucketStart: {$gte: new Date(fromHour), $lt: new Date(toHour)}}},
            {
                $group: {
                    _id: "$meta.service",
                    samples: {$sum: 1},
                    upSamples: {$sum: "$up"},
                    breakerOpenSamples: {
                        $sum: {$cond: [{$eq: ["$circuitBreakerState", "OPEN"]}, 1, 0]}
                    },
                    completedJobs: {$sum: "$completedJobsDelta"},
                    failedJobs: {$sum: "$failedJobsDelta"},
                    avgTimeWeighted: {
                        // Weight per-minute averageTime by the operation count
                        // in that minute so the hourly average reflects work
                        // distribution rather than minute count.
                        $sum: {
                            $multiply: [
                                "$averageTime",
                                {$add: ["$completedJobsDelta", "$failedJobsDelta"]}
                            ]
                        }
                    }
                }
            }
        ]).exec();

        if (docs.length === 0) {
            log.finish("No 1m rows in the previous hour; skipping");
            return;
        }

        const targetBucket = new Date(fromHour);
        const inserts = docs.map((d: any) => {
            const samples = d.samples;
            const upSamples = d.upSamples;
            const totalOps = (d.completedJobs || 0) + (d.failedJobs || 0);
            return {
                insertOne: {
                    document: {
                        bucketStart: targetBucket,
                        meta: {service: d._id},
                        samples,
                        upSamples,
                        uptimePct: samples > 0 ? upSamples / samples : 0,
                        breakerOpenSamples: d.breakerOpenSamples || 0,
                        completedJobs: d.completedJobs || 0,
                        failedJobs: d.failedJobs || 0,
                        averageTime: totalOps > 0 ? Math.round(d.avgTimeWeighted / totalOps) : 0
                    }
                }
            };
        });

        if (inserts.length > 0) {
            await ServerHealth1h.bulkWrite(inserts, {ordered: false});
        }
        log.finish(`Hourly health rollup wrote ${inserts.length} rows for window ${new Date(fromHour).toISOString()} -> ${new Date(toHour).toISOString()}`);
    }
    catch (err: any) {
        log.err(`Hourly health rollup failed: ${err?.message}`);
    }
}

/**
 * Rolls the previous closed day of `serverHealth1h` rows into a single
 * `serverHealth1d` row per service.
 */
async function runDailyRollup(parentLogger?: serverLogger): Promise<void> {
    const log = getLogger("server_health_rollup_1d", parentLogger);
    log.start("Running daily rollup (serverHealth1h -> serverHealth1d)");

    const now = Date.now();
    const dayStart = Math.floor(now / ONE_DAY_MS) * ONE_DAY_MS;
    const fromDay = dayStart - ONE_DAY_MS;
    const toDay = dayStart;

    try {
        const docs: IServerHealth1h[] = await ServerHealth1h.aggregate([
            {$match: {bucketStart: {$gte: new Date(fromDay), $lt: new Date(toDay)}}},
            {
                $group: {
                    _id: "$meta.service",
                    samples: {$sum: "$samples"},
                    upSamples: {$sum: "$upSamples"},
                    breakerOpenSamples: {$sum: "$breakerOpenSamples"},
                    completedJobs: {$sum: "$completedJobs"},
                    failedJobs: {$sum: "$failedJobs"},
                    avgTimeWeighted: {
                        $sum: {
                            $multiply: [
                                "$averageTime",
                                {$add: ["$completedJobs", "$failedJobs"]}
                            ]
                        }
                    }
                }
            }
        ]).exec();

        if (docs.length === 0) {
            log.finish("No 1h rows in the previous day; skipping");
            return;
        }

        const targetBucket = new Date(fromDay);
        const inserts = docs.map((d: any) => {
            const samples = d.samples;
            const upSamples = d.upSamples;
            const totalOps = (d.completedJobs || 0) + (d.failedJobs || 0);
            return {
                insertOne: {
                    document: {
                        bucketStart: targetBucket,
                        meta: {service: d._id},
                        samples,
                        upSamples,
                        uptimePct: samples > 0 ? upSamples / samples : 0,
                        breakerOpenSamples: d.breakerOpenSamples || 0,
                        completedJobs: d.completedJobs || 0,
                        failedJobs: d.failedJobs || 0,
                        averageTime: totalOps > 0 ? Math.round(d.avgTimeWeighted / totalOps) : 0
                    }
                }
            };
        });

        if (inserts.length > 0) {
            await ServerHealth1d.bulkWrite(inserts, {ordered: false});
        }
        log.finish(`Daily health rollup wrote ${inserts.length} rows for window ${new Date(fromDay).toISOString()} -> ${new Date(toDay).toISOString()}`);
    }
    catch (err: any) {
        log.err(`Daily health rollup failed: ${err?.message}`);
    }
}

/**
 * Starts the per-minute health snapshot cron. Idempotent.
 *
 * Pass the same `getHealthData` function the broadcaster uses so the
 * snapshot is read from the WS server's authoritative source (the only
 * process that owns the in-memory connection registries).
 */
export function startServerHealthSnapshotting(
    fetchHealth: () => Promise<ServerHealthFormResponseType>,
    parentLogger?: serverLogger
): void {
    if (snapshotJob !== null) return;
    snapshotJob = new CronJob(
        "0 * * * * *",
        () => { void takeHealthSnapshot(fetchHealth, parentLogger); },
        null,
        true,
        "UTC"
    );
    getLogger("server_health_snapshot_jobs", parentLogger)
        .debug("Per-minute server health snapshot scheduled (cron: 0 * * * * *)");
}

/**
 * Starts the hourly + daily server-health rollup crons. Idempotent.
 */
export function startServerHealthRollupJobs(parentLogger?: serverLogger): void {
    const log = getLogger("server_health_rollup_jobs", parentLogger);
    if (hourlyJob === null) {
        hourlyJob = new CronJob("0 1 * * * *", () => { void runHourlyRollup(parentLogger); }, null, true, "UTC");
        log.debug("Hourly server health rollup scheduled (cron: 0 1 * * * *)");
    }
    if (dailyJob === null) {
        dailyJob = new CronJob("0 5 0 * * *", () => { void runDailyRollup(parentLogger); }, null, true, "UTC");
        log.debug("Daily server health rollup scheduled (cron: 0 5 0 * * *)");
    }
}

export function stopServerHealthHistoryJobs(): void {
    if (snapshotJob) { snapshotJob.stop(); snapshotJob = null; }
    if (hourlyJob) { hourlyJob.stop(); hourlyJob = null; }
    if (dailyJob) { dailyJob.stop(); dailyJob = null; }
}
