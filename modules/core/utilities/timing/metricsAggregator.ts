/**
 * Metrics Aggregator
 *
 * In-memory bucketed time-series aggregator for API endpoint performance.
 *
 * Design (state-of-the-art "simple yet effective"):
 * - Per (method + endpoint) key, maintain a fixed ring buffer of 60 one-minute buckets (1h window).
 * - Each bucket holds: count, errorCount, sumDuration, sumSquaredDuration, min, max,
 *   plus a fixed-size reservoir (Algorithm R) of duration samples for accurate percentiles.
 * - Inserts are O(1). Snapshots are O(B * E) where B=60 buckets, E=unique endpoints.
 * - Memory bounded: ~256 numbers per bucket per endpoint.
 *
 * The aggregator is the single live source of truth for endpoint stats:
 *  - The metrics Kafka consumer feeds it via `addSample(...)`.
 *  - The websocket push scheduler reads `getSnapshot(...)` at a low cadence.
 *  - A 1-minute timer flushes the just-closed bucket to the Mongo time-series collection.
 *
 * No external percentile sketch dependency: a fixed-size reservoir per bucket gives
 * unbiased random samples; merging reservoirs across buckets and sorting yields
 * percentile estimates with ~1-3% error at the configured sample size.
 *
 * @module utilities/core/timing/metricsAggregator
 */

const ONE_MINUTE_MS = 60_000;
const DEFAULT_BUCKETS = 60;             // 1 hour window
const DEFAULT_RESERVOIR_SIZE = 256;     // samples per bucket per endpoint

/**
 * Public window selectors. Maps to a count of trailing 1-minute buckets.
 */
export type AggregatorWindow = "1m" | "5m" | "15m" | "1h";
const WINDOW_TO_BUCKETS: Record<AggregatorWindow, number> = { 
    "1m": 1,
    "5m": 5,
    "15m": 15,
    "1h": 60
};

/**
 * One sample event: a single completed request observation.
 */
export type ApiSample = {
    method: string;
    endpoint: string;
    durationMs: number;
    statusCode: number;
    timestamp: number;
};

/**
 * Snapshot statistics produced for a single (method, endpoint) over a window.
 */
export type EndpointSnapshot = {
    method: string;
    endpoint: string;
    count: number;
    errors: number;
    errorRate: number;        // 0..100
    averageDuration: number;  // ms (rounded)
    minDuration: number;      // ms
    maxDuration: number;      // ms
    p50: number;              // ms
    p95: number;              // ms
    p99: number;              // ms
    lastExecuted: number;     // unix ms
};

type Bucket = {
    count: number;
    errors: number;
    sum: number;
    sumSq: number;
    min: number;
    max: number;
    /** Fixed-size reservoir of recent durations. Length capped to RESERVOIR_SIZE. */
    reservoir: number[];
    /** Reservoir Algorithm R seen-count (used to decide replacement). */
    seen: number;
    /** Most recent sample timestamp inside this bucket. */
    lastTs: number;
};

type EndpointKey = string; // `${method} ${endpoint}`

const emptyBucket = (): Bucket => ({
    count: 0,
    errors: 0,
    sum: 0,
    sumSq: 0,
    min: Number.POSITIVE_INFINITY,
    max: 0,
    reservoir: [],
    seen: 0,
    lastTs: 0
});

/**
 * Encode a (method, endpoint) pair as a single map key. The space char is safe
 * because HTTP methods cannot contain spaces.
 */
export function endpointKeyOf(method: string, endpoint: string): EndpointKey {
    return `${method} ${endpoint}`;
}

/**
 * Decode an endpoint key produced by `endpointKeyOf`.
 */
export function parseEndpointKey(key: EndpointKey): { method: string; endpoint: string } {
    const idx = key.indexOf(" ");
    if (idx < 0) return { method: "UNKNOWN", endpoint: key };
    return { method: key.slice(0, idx), endpoint: key.slice(idx + 1) };
}

/**
 * Returns the unix-ms timestamp of the start of the minute that contains `ts`.
 */
export function bucketStartOf(ts: number): number {
    return Math.floor(ts / ONE_MINUTE_MS) * ONE_MINUTE_MS;
}

/**
 * A single endpoint's circular ring buffer of 1-minute buckets.
 * Buckets are addressed by `bucketStart` modulo `numBuckets`.
 */
class EndpointSeries {
    /** Indexed by `(bucketStart / ONE_MINUTE_MS) % numBuckets`. */
    private readonly buckets: Bucket[];
    /** Parallel array tracking which `bucketStart` each slot currently holds. */
    private readonly slotStart: number[];

    constructor(public readonly numBuckets: number, public readonly reservoirSize: number) {
        this.buckets = Array.from({ length: numBuckets }, () => emptyBucket());
        this.slotStart = new Array(numBuckets).fill(0);
    }

    /**
     * Records a single sample inside the bucket containing `ts`.
     * Resets the slot if it was previously occupied by an older bucket (slot reuse).
     */
    addSample(durationMs: number, isError: boolean, ts: number): void {
        const start = bucketStartOf(ts);
        const slot = (start / ONE_MINUTE_MS) % this.numBuckets;
        const bucket = this.buckets[slot];
        if (this.slotStart[slot] !== start) {
            // Slot belongs to a different (older) minute; reset it before reuse.
            this.slotStart[slot] = start;
            this.resetBucket(bucket);
        }
        bucket.count++;
        if (isError) bucket.errors++;
        bucket.sum += durationMs;
        bucket.sumSq += durationMs * durationMs;
        if (durationMs < bucket.min) bucket.min = durationMs;
        if (durationMs > bucket.max) bucket.max = durationMs;
        if (ts > bucket.lastTs) bucket.lastTs = ts;
        // Algorithm R reservoir sampling.
        bucket.seen++;
        if (bucket.reservoir.length < this.reservoirSize) {
            bucket.reservoir.push(durationMs);
        }
        else {
            const j = Math.floor(Math.random() * bucket.seen);
            if (j < this.reservoirSize) {
                bucket.reservoir[j] = durationMs;
            }
        }
    }

    /**
     * Returns a copy of the (already-closed) bucket at `bucketStart`, or null
     * if that bucket no longer occupies its slot.
     */
    getBucketAt(bucketStart: number): Bucket | null {
        const slot = (bucketStart / ONE_MINUTE_MS) % this.numBuckets;
        if (this.slotStart[slot] !== bucketStart) return null;
        const b = this.buckets[slot];
        if (b.count === 0) return null;
        return { ...b, reservoir: b.reservoir.slice() };
    }

    /**
     * Merges the last `windowBuckets` buckets ending at the bucket containing `now`,
     * producing aggregate stats. Returns null if the window has no samples.
     */
    snapshot(windowBuckets: number, now: number): EndpointSnapshot | null {
        const currentStart = bucketStartOf(now);
        let count = 0;
        let errors = 0;
        let sum = 0;
        let min = Number.POSITIVE_INFINITY;
        let max = 0;
        let lastTs = 0;
        const merged: number[] = [];
        for (let i = 0; i < windowBuckets; i++) {
            const start = currentStart - i * ONE_MINUTE_MS;
            const slot = (start / ONE_MINUTE_MS) % this.numBuckets;
            if (this.slotStart[slot] !== start) continue;
            const b = this.buckets[slot];
            if (b.count === 0) continue;
            count += b.count;
            errors += b.errors;
            sum += b.sum;
            if (b.min < min) min = b.min;
            if (b.max > max) max = b.max;
            if (b.lastTs > lastTs) lastTs = b.lastTs;
            // Concatenate reservoirs; bounded to windowBuckets * reservoirSize.
            for (let r = 0; r < b.reservoir.length; r++) merged.push(b.reservoir[r]);
        }
        if (count === 0) return null;
        merged.sort((a, b) => a - b);
        const avg = sum / count;
        return {
            method: "",      // filled in by caller
            endpoint: "",    // filled in by caller
            count,
            errors,
            errorRate: count === 0 ? 0 : (errors / count) * 100,
            averageDuration: Math.round(avg),
            minDuration: min === Number.POSITIVE_INFINITY ? 0 : Math.round(min),
            maxDuration: Math.round(max),
            p50: Math.round(percentile(merged, 0.5, avg)),
            p95: Math.round(percentile(merged, 0.95, avg)),
            p99: Math.round(percentile(merged, 0.99, max || avg)),
            lastExecuted: lastTs
        };
    }

    private resetBucket(b: Bucket): void {
        b.count = 0;
        b.errors = 0;
        b.sum = 0;
        b.sumSq = 0;
        b.min = Number.POSITIVE_INFINITY;
        b.max = 0;
        b.reservoir.length = 0;
        b.seen = 0;
        b.lastTs = 0;
    }
}

/**
 * Picks the value at `p` percentile (0..1) from a pre-sorted array.
 * Falls back to `fallback` when the array is empty.
 */
function percentile(sorted: number[], p: number, fallback: number): number {
    if (sorted.length === 0) return fallback;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)));
    return sorted[idx];
}

/**
 * Closed-bucket payload emitted on every minute boundary, suitable for
 * persistence to a Mongo time-series collection.
 */
export type ClosedBucket = {
    bucketStart: Date;
    method: string;
    endpoint: string;
    count: number;
    errors: number;
    sum: number;
    sumSq: number;
    min: number;
    max: number;
    p50: number;
    p95: number;
    p99: number;
    lastExecuted: Date;
};

/**
 * The MetricsAggregator owns one EndpointSeries per (method, endpoint) and a
 * minute-boundary timer that closes buckets and emits them to subscribers.
 *
 * Threading: this code is intended to run on a single Node.js event loop
 * (the WebSocket server process). Cross-process aggregation is not in scope.
 */
export class MetricsAggregator {
    private readonly series = new Map<EndpointKey, EndpointSeries>();
    private readonly numBuckets: number;
    private readonly reservoirSize: number;
    private flushTimer: NodeJS.Timeout | null = null;
    private readonly subscribers: Array<(buckets: ClosedBucket[]) => void> = [];
    private lastClosedStart: number = 0;

    constructor(opts: { numBuckets?: number; reservoirSize?: number } = {}) {
        this.numBuckets = opts.numBuckets ?? DEFAULT_BUCKETS;
        this.reservoirSize = opts.reservoirSize ?? DEFAULT_RESERVOIR_SIZE;
    }

    /**
     * Records a single API sample. Hot path - O(1).
     */
    addSample(sample: ApiSample): void {
        const key = endpointKeyOf(sample.method, sample.endpoint);
        let s = this.series.get(key);
        if (!s) {
            s = new EndpointSeries(this.numBuckets, this.reservoirSize);
            this.series.set(key, s);
        }
        s.addSample(sample.durationMs, sample.statusCode >= 400, sample.timestamp);
    }

    /**
     * Returns a sorted snapshot of all endpoints within the requested window.
     */
    snapshot(window: AggregatorWindow = "5m", now: number = Date.now()): EndpointSnapshot[] {
        const windowBuckets = WINDOW_TO_BUCKETS[window];
        const out: EndpointSnapshot[] = [];
        for (const [key, s] of this.series) {
            const snap = s.snapshot(windowBuckets, now);
            if (!snap) continue;
            const { method, endpoint } = parseEndpointKey(key);
            snap.method = method;
            snap.endpoint = endpoint;
            out.push(snap);
        }
        return out;
    }

    /**
     * Returns a digest summary commonly used by the WS broadcaster and stats endpoint.
     */
    digest(window: AggregatorWindow = "5m", topN: number = 20, now: number = Date.now()): {
        totalRequests: number;
        totalErrors: number;
        uniqueEndpoints: number;
        slowest: EndpointSnapshot[];
        mostCalled: EndpointSnapshot[];
        highestErrorRate: EndpointSnapshot[];
        all: EndpointSnapshot[];
    } {
        const all = this.snapshot(window, now);
        const totalRequests = all.reduce((acc, s) => acc + s.count, 0);
        const totalErrors = all.reduce((acc, s) => acc + s.errors, 0);
        const slowest = [...all].sort((a, b) => b.averageDuration - a.averageDuration).slice(0, topN);
        const mostCalled = [...all].sort((a, b) => b.count - a.count).slice(0, topN);
        const highestErrorRate = all
            .filter((s) => s.errors > 0)
            .sort((a, b) => b.errorRate - a.errorRate)
            .slice(0, topN);
        return {
            totalRequests,
            totalErrors,
            uniqueEndpoints: all.length,
            slowest,
            mostCalled,
            highestErrorRate,
            /** Full merged window stats per endpoint (not capped to topN). */
            all
        };
    }

    /**
     * Subscribes to closed-bucket flushes. Each callback receives the buckets that
     * just transitioned out of the "current" minute. Used by the persistence writer.
     */
    onMinuteFlush(cb: (buckets: ClosedBucket[]) => void): () => void {
        this.subscribers.push(cb);
        return () => {
            const idx = this.subscribers.indexOf(cb);
            if (idx >= 0) this.subscribers.splice(idx, 1);
        };
    }

    /**
     * Starts the per-minute flush loop. Idempotent.
     */
    start(): void {
        if (this.flushTimer) return;
        this.lastClosedStart = bucketStartOf(Date.now()) - ONE_MINUTE_MS;
        const tick = () => {
            try {
                this.flushClosedBuckets(Date.now());
            }
            catch {
                // Persistence subscribers may throw; never let that kill the timer.
            }
        };
        // Align next tick to ~3s past the next minute boundary so the just-closed
        // minute has settled (samples are written by their event-loop turn).
        const now = Date.now();
        const nextMinute = bucketStartOf(now) + ONE_MINUTE_MS;
        const initialDelay = (nextMinute - now) + 3_000;
        this.flushTimer = setTimeout(() => {
            tick();
            this.flushTimer = setInterval(tick, ONE_MINUTE_MS);
        }, initialDelay);
    }

    /**
     * Stops the flush loop. Idempotent.
     */
    stop(): void {
        if (!this.flushTimer) return;
        clearTimeout(this.flushTimer);
        clearInterval(this.flushTimer);
        this.flushTimer = null;
    }

    /**
     * Drops all in-memory state. Used by tests.
     */
    clear(): void {
        this.series.clear();
        this.lastClosedStart = 0;
    }

    /**
     * Number of unique (method, endpoint) keys currently tracked.
     */
    size(): number {
        return this.series.size;
    }

    /**
     * Emits closed-bucket events for every minute that ended on or before `now`
     * but has not yet been flushed. Multiple buckets may flush at once if the
     * timer fired late.
     */
    private flushClosedBuckets(now: number): void {
        const currentStart = bucketStartOf(now);
        // Walk forward from lastClosedStart+1 minute to currentStart-1 minute, flushing each.
        let from = this.lastClosedStart + ONE_MINUTE_MS;
        if (from < currentStart - this.numBuckets * ONE_MINUTE_MS) {
            // We've been silent for longer than the ring; skip ahead to avoid re-emitting stale slots.
            from = currentStart - this.numBuckets * ONE_MINUTE_MS;
        }
        for (let bucketStart = from; bucketStart < currentStart; bucketStart += ONE_MINUTE_MS) {
            const closed: ClosedBucket[] = [];
            for (const [key, s] of this.series) {
                const b = s.getBucketAt(bucketStart);
                if (!b) continue;
                const { method, endpoint } = parseEndpointKey(key);
                const merged = b.reservoir.slice().sort((a, b) => a - b);
                const avg = b.count === 0 ? 0 : b.sum / b.count;
                closed.push({
                    bucketStart: new Date(bucketStart),
                    method,
                    endpoint,
                    count: b.count,
                    errors: b.errors,
                    sum: b.sum,
                    sumSq: b.sumSq,
                    min: b.min === Number.POSITIVE_INFINITY ? 0 : b.min,
                    max: b.max,
                    p50: Math.round(percentile(merged, 0.5, avg)),
                    p95: Math.round(percentile(merged, 0.95, avg)),
                    p99: Math.round(percentile(merged, 0.99, b.max || avg)),
                    lastExecuted: new Date(b.lastTs || bucketStart)
                });
            }
            if (closed.length > 0) {
                for (const sub of this.subscribers) {
                    try {
                        sub(closed);
                    }
                    catch {
                        // Subscribers must be defensive themselves.
                    }
                }
            }
            this.lastClosedStart = bucketStart;
        }
    }
}

/**
 * Process-wide aggregator instance. Both the API and WebSocket processes import
 * the same module instance, but only the WebSocket process should call `start()`
 * since it owns persistence and broadcasting. The API process uses it as a
 * read-only view only when its `metricsConsumer` is also wired in.
 */
export const metricsAggregator = new MetricsAggregator();
