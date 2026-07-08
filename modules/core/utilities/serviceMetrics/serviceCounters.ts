/**
 * Service Counters
 *
 * Cross-process, restart-persistent operational counters per service.
 *
 * Each service (kafka, redis, websocket, …) owns one counter that tracks:
 *  - completedJobs: count of successful operations
 *  - failedJobs:    count of failed operations
 *  - totalTime:     cumulative duration in ms (for averageTime computation)
 *
 * Storage model:
 *  - Each process holds an in-memory `delta` of counters since last flush.
 *  - Every flush interval (5s), the deltas are atomically `HINCRBY`-ed into
 *    a Redis hash named `metrics:counters:{service}`, then the deltas reset
 *    and the hydrated totals are bumped locally so subsequent reads include
 *    the just-flushed values without a round-trip to Redis.
 *  - On startup, `hydrate()` does one `HGETALL` per service to seed totals.
 *
 * Why deltas + flush instead of synchronous Redis on every op?
 *  - Avoids a Redis round-trip on the hot path of every Kafka send / Redis get.
 *  - Avoids the recursive trap of "counting Redis ops via Redis" causing infinite
 *    instrumentation when the Redis op itself is the counter write.
 *  - Aggregates many in-flight increments into a few INCRBY calls.
 *
 * Cross-process aggregation:
 *  - All processes (api, kafka, ws) flush to the same Redis hash.
 *  - Any reader's hydrate-then-add-deltas yields a globally consistent
 *    "near-real-time" view (5s eventual consistency).
 *
 * @module utilities/core/serviceMetrics/serviceCounters
 */

import {getLogger} from "@coreModule/loggers/serverLog";
import {getRedisClient, isRedisConnected} from "@coreModule/connections/connectToRedis";

/** Logical service identifiers tracked by this module. */
export type ServiceCounterKey =
    | "kafka"
    | "redis"
    | "websocket"
    | "telegram"
    | "mongoDb";

const REDIS_KEY_PREFIX = "metrics:counters:";
const FLUSH_INTERVAL_MS = 5_000;

const logger = getLogger("service_counters");

/**
 * Per-service in-memory + Redis-backed counter.
 *
 * Internal contract:
 *  - `record*` mutates only the local `delta*` fields.
 *  - `flush()` performs INCRBY on Redis, then folds the delta into
 *    `hydrated*` so subsequent `getStats()` calls reflect the change.
 *  - `getStats()` returns `hydrated + delta` so reads are always non-decreasing
 *    and never go negative across a flush race.
 */
export class ServiceCounter {
    private hydratedCompleted = 0;
    private hydratedFailed = 0;
    private hydratedTime = 0;

    private deltaCompleted = 0;
    private deltaFailed = 0;
    private deltaTime = 0;

    private hydrated = false;

    constructor(public readonly service: ServiceCounterKey) {}

    /** Records one successful operation that took `durationMs`. */
    recordSuccess(durationMs: number): void {
        this.deltaCompleted++;
        if (durationMs > 0) this.deltaTime += durationMs;
    }

    /** Records one failed operation that took `durationMs` before failing. */
    recordFailure(durationMs: number): void {
        this.deltaFailed++;
        if (durationMs > 0) this.deltaTime += durationMs;
    }

    /**
     * Returns the current combined counters. Safe to call from any process;
     * value is `hydrated + delta` so it reflects every record made in this
     * process regardless of flush timing.
     */
    getStats(): { completedJobs: number; failedJobs: number; totalTime: number; averageTime: number } {
        const completed = this.hydratedCompleted + this.deltaCompleted;
        const failed = this.hydratedFailed + this.deltaFailed;
        const total = this.hydratedTime + this.deltaTime;
        const samples = completed + failed;
        return {
            completedJobs: completed,
            failedJobs: failed,
            totalTime: total,
            averageTime: samples === 0 ? 0 : Math.round(total / samples)
        };
    }

    /**
     * Loads the latest persisted counters from Redis into the hydrated cache.
     * Idempotent. Falls back silently when Redis isn't reachable.
     */
    async hydrate(): Promise<void> {
        if (!isRedisConnected()) return;
        try {
            const data = await getRedisClient().hGetAll(REDIS_KEY_PREFIX + this.service);
            this.hydratedCompleted = numericField(data?.completed);
            this.hydratedFailed = numericField(data?.failed);
            this.hydratedTime = numericField(data?.time);
            this.hydrated = true;
        }
        catch (err: any) {
            logger.warn(`[${this.service}] hydrate failed: ${err?.message}`);
        }
    }

    /**
     * Atomically applies the in-memory deltas to the Redis-backed totals via
     * `HINCRBY`, then re-reads the canonical totals to fold in increments
     * made by sibling processes since our last hydrate.
     *
     * If Redis is down, deltas are kept locally — the next successful flush
     * will persist them. We never lose counts inside this process; we only
     * lose the ones that haven't been flushed yet across a hard crash.
     */
    async flush(): Promise<void> {
        if (!isRedisConnected()) return;

        const c = this.deltaCompleted;
        const f = this.deltaFailed;
        const t = this.deltaTime;
        // Reset deltas BEFORE awaiting Redis so concurrent record* calls during
        // the network round-trip start a fresh delta accumulation rather than
        // being absorbed into the in-flight flush.
        this.deltaCompleted = 0;
        this.deltaFailed = 0;
        this.deltaTime = 0;

        const client = getRedisClient();
        const key = REDIS_KEY_PREFIX + this.service;

        try {
            const ops: Promise<unknown>[] = [];
            if (c > 0) ops.push(client.hIncrBy(key, "completed", c));
            if (f > 0) ops.push(client.hIncrBy(key, "failed", f));
            if (t > 0) ops.push(client.hIncrBy(key, "time", t));
            if (ops.length > 0) await Promise.all(ops);

            // Read the canonical values back so the local hydrated total
            // reflects every process's contribution, not just our own.
            const data = await client.hGetAll(key);
            this.hydratedCompleted = numericField(data?.completed);
            this.hydratedFailed = numericField(data?.failed);
            this.hydratedTime = numericField(data?.time);
            this.hydrated = true;
        }
        catch (err: any) {
            // Restore deltas so the next flush retries them. Order doesn't
            // matter for sums; concurrent record* calls only enlarge the next
            // flush's delta which is also fine.
            this.deltaCompleted += c;
            this.deltaFailed += f;
            this.deltaTime += t;
            logger.warn(`[${this.service}] flush failed: ${err?.message}`);
        }
    }
}

function numericField(v: string | undefined): number {
    if (!v) return 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

/**
 * Process-wide singleton counters. All operations route through these.
 */
export const kafkaCounter = new ServiceCounter("kafka");
export const redisCounter = new ServiceCounter("redis");
export const webSocketCounter = new ServiceCounter("websocket");
export const telegramCounter = new ServiceCounter("telegram");
export const mongoDbCounter = new ServiceCounter("mongoDb");

const ALL_COUNTERS: ServiceCounter[] = [
    kafkaCounter,
    redisCounter,
    webSocketCounter,
    telegramCounter,
    mongoDbCounter
];

let flushTimer: NodeJS.Timeout | null = null;

/**
 * Hydrates all counters from Redis. Call once on process startup after Redis
 * connects. Safe to call multiple times (idempotent).
 */
export async function hydrateAllServiceCounters(): Promise<void> {
    await Promise.all(ALL_COUNTERS.map((c) => c.hydrate()));
}

/**
 * Starts the periodic flush loop. Idempotent.
 *
 * The flush is fire-and-forget per counter; transient Redis failures are
 * handled by re-adding deltas inside `flush()`.
 */
export function startServiceCountersFlush(): void {
    if (flushTimer) return;
    flushTimer = setInterval(() => {
        for (const counter of ALL_COUNTERS) {
            void counter.flush();
        }
    }, FLUSH_INTERVAL_MS);
}

export function stopServiceCountersFlush(): void {
    if (flushTimer) {
        clearInterval(flushTimer);
        flushTimer = null;
    }
}
