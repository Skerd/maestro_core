/**
 * Performance Persistence
 *
 * Subscribes to closed-bucket events from the in-memory `MetricsAggregator` and
 * persists each minute's per-endpoint summary to the `serverPerformance1m`
 * Mongo time-series collection.
 *
 * @module utilities/core/timing/performancePersistence
 */

import {getLogger} from "@coreModule/loggers/serverLog";
import {ClosedBucket, metricsAggregator} from "@coreModule/utilities/timing/metricsAggregator";
import {serverPerformanceService} from "@coreModule/database/schemas/performance/serverPerformance/serverPerformance.service";

const logger = getLogger("performance_persistence");
let unsubscribe: (() => void) | null = null;

/**
 * Wires the aggregator -> Mongo bridge. Idempotent.
 */
export function startPerformancePersistence(): void {
    if (unsubscribe) return;
    unsubscribe = metricsAggregator.onMinuteFlush(handleClosedBuckets);
    logger.debug("Performance persistence subscriber wired to MetricsAggregator.flushClosedBuckets"); 
}

export function stopPerformancePersistence(): void {
    if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
    }
}

async function handleClosedBuckets(buckets: ClosedBucket[]): Promise<void> {
    if (buckets.length === 0) return;

    try {
        const ops = buckets.map((b) => ({
            insertOne: {
                document: {
                    bucketStart: b.bucketStart,
                    meta: { method: b.method, endpoint: b.endpoint },
                    count: b.count,
                    errors: b.errors,
                    sum: b.sum,
                    sumSq: b.sumSq,
                    min: b.min,
                    max: b.max,
                    p50: b.p50,
                    p95: b.p95,
                    p99: b.p99,
                    lastExecuted: b.lastExecuted
                }
            }
        }));
        await serverPerformanceService.insertBuckets("1m", ops);
    }
    catch (err: any) {
        logger.warn(`Failed to persist ${buckets.length} performance buckets: ${err?.message}`);
    }
}
