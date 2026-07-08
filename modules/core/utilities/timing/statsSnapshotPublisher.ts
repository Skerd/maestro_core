/**
 * Stats Snapshot Publisher
 *
 * Periodically materializes the current aggregator digest and writes it to
 * Redis under a well-known key. The REST `/auxiliary/stats` endpoint reads
 * from this key so the API server never has to do aggregation work for the
 * "live" window — it just hands back the latest snapshot.
 *
 * Cadence: every 5s. The snapshot covers the trailing 5-minute window.
 *
 * @module utilities/core/timing/statsSnapshotPublisher
 */

import {getLogger} from "@coreModule/loggers/serverLog";
import {isRedisConnected, redisSetEx} from "@coreModule/connections/connectToRedis";
import {metricsAggregator} from "@coreModule/utilities/timing/metricsAggregator";

/**
 * Redis key holding the latest serialized stats digest.
 */
export const STATS_SNAPSHOT_KEY = "stats:snapshot";

/**
 * Snapshot TTL — slightly longer than the publish cadence so a brief stall
 * doesn't make the API endpoint return stale-empty data.
 */
const SNAPSHOT_TTL_SECONDS = 30;
const PUBLISH_INTERVAL_MS = 5_000;

let timer: NodeJS.Timeout | null = null;
const logger = getLogger("stats_snapshot_publisher");

/**
 * Snapshot envelope written to Redis. Kept JSON-serializable and free of
 * Mongoose types so consumers can decode safely.
 */
export type StatsSnapshotEnvelope = {
    publishedAt: string;
    window: "5m";
    summary: {
        totalRequests: number;
        totalErrors: number;
        uniqueEndpoints: number;
    };
    endpoints: {
        slowest: ReturnType<typeof metricsAggregator.snapshot>;
        mostCalled: ReturnType<typeof metricsAggregator.snapshot>;
        highestErrorRate: ReturnType<typeof metricsAggregator.snapshot>;
        all: ReturnType<typeof metricsAggregator.snapshot>;
    };
};

async function publishOnce(): Promise<void> {
    if (!isRedisConnected()) return;
    try {
        const digest = metricsAggregator.digest("5m", 20);
        const envelope: StatsSnapshotEnvelope = {
            publishedAt: new Date().toISOString(),
            window: "5m",
            summary: {
                totalRequests: digest.totalRequests,
                totalErrors: digest.totalErrors,
                uniqueEndpoints: digest.uniqueEndpoints
            },
            endpoints: {
                slowest: digest.slowest,
                mostCalled: digest.mostCalled,
                highestErrorRate: digest.highestErrorRate,
                all: digest.all
            }
        };
        await redisSetEx(STATS_SNAPSHOT_KEY, SNAPSHOT_TTL_SECONDS, JSON.stringify(envelope));
    }
    catch (err: any) {
        // Snapshot failures are non-critical; the API endpoint can fall back to time-series.
        logger.debug(`Failed to publish stats snapshot: ${err?.message}`);
    }
}

/**
 * Starts the publish loop. Idempotent.
 */
export function startStatsSnapshotPublisher(): void {
    if (timer) return;
    void publishOnce();
    timer = setInterval(() => { void publishOnce(); }, PUBLISH_INTERVAL_MS);
}

export function stopStatsSnapshotPublisher(): void {
    if (timer) { 
        clearInterval(timer);
        timer = null;
    }
}
