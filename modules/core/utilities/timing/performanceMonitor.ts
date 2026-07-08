/**
 * Performance Monitor (compat shim)
 *
 * Historic surface preserved for callers that still import this module.
 * All real aggregation is delegated to the bucketed `MetricsAggregator`.
 *
 * The legacy unbounded array implementation has been replaced by the
 * memory-bounded ring-buffer aggregator. Behaviour notes:
 *  - `record(...)` and `recordTiming(...)` route into the aggregator under
 *    a synthetic `(method=GET, endpoint=functionName)` key when no method
 *    can be inferred. This keeps decorator/instrumentation users working.
 *  - `getStats(...)`, `getAllStats(...)`, `getSlowestFunctions(...)` and
 *    `getMostCalledFunctions(...)` produce the same shape as before.
 *  - The "method endpoint" → functionName mapping uses a space separator,
 *    matching how the metrics middleware enqueues api samples.
 *
 * @module utilities/core/timing/performanceMonitor
 */

import {TimingResult} from "./functionTimer";
import {endpointKeyOf, metricsAggregator, parseEndpointKey} from "./metricsAggregator";

/**
 * Performance metric entry (preserved for type compatibility).
 */
export interface PerformanceMetric { 
    functionName: string;
    duration: number;
    timestamp: number;
    success: boolean;
    error?: string;
}

/**
 * Aggregated performance statistics (preserved for type compatibility).
 */
export interface PerformanceStats {
    functionName: string;
    count: number;
    totalDuration: number;
    averageDuration: number;
    minDuration: number;
    maxDuration: number;
    p50: number;
    p95: number;
    p99: number;
    errors: number;
    lastExecuted: number;
}

const HTTP_METHOD_RE = /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s/;

function splitFunctionName(functionName: string): { method: string; endpoint: string } {
    if (HTTP_METHOD_RE.test(functionName)) {
        return parseEndpointKey(functionName);
    }
    // Synthetic method for non-HTTP timings (decorators, ad-hoc timeBlock callers).
    return { method: "FN", endpoint: functionName };
}

/**
 * Performance Monitor compatibility facade.
 *
 * Reads/writes the shared `metricsAggregator`. State-of-the-art behaviour
 * (bounded memory, percentile estimation) is provided by the aggregator;
 * this class simply translates the legacy API to the aggregator's shape.
 */
export class PerformanceMonitor {
    private enabled: boolean = true;

    record(metric: PerformanceMetric): void {
        if (!this.enabled) return;
        const { method, endpoint } = splitFunctionName(metric.functionName);
        metricsAggregator.addSample({
            method,
            endpoint,
            durationMs: metric.duration,
            statusCode: metric.success ? 200 : 500,
            timestamp: metric.timestamp || Date.now()
        });
    }

    recordTiming(timing: TimingResult, success: boolean = true, error?: string): void {
        this.record({
            functionName: timing.functionName,
            duration: timing.duration,
            timestamp: timing.startTime,
            success,
            error
        });
    }

    getStats(functionName: string): PerformanceStats | null {
        const all = this.getAllStats();
        return all.find((s) => s.functionName === functionName) ?? null;
    }

    getAllStats(): PerformanceStats[] {
        const snaps = metricsAggregator.snapshot("1h");
        return snaps
            .map<PerformanceStats>((s) => ({
                functionName: endpointKeyOf(s.method, s.endpoint),
                count: s.count,
                totalDuration: s.averageDuration * s.count,
                averageDuration: s.averageDuration,
                minDuration: s.minDuration,
                maxDuration: s.maxDuration,
                p50: s.p50,
                p95: s.p95,
                p99: s.p99,
                errors: s.errors,
                lastExecuted: s.lastExecuted
            }))
            .sort((a, b) => b.averageDuration - a.averageDuration);
    }

    getSlowestFunctions(limit: number = 10): PerformanceStats[] {
        return this.getAllStats().slice(0, limit);
    }

    getMostCalledFunctions(limit: number = 10): PerformanceStats[] {
        return this.getAllStats().sort((a, b) => b.count - a.count).slice(0, limit);
    }

    clear(): void {
        metricsAggregator.clear();
    }

    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
    }

    isEnabled(): boolean {
        return this.enabled;
    }

    getSummary(): {
        totalMetrics: number;
        uniqueFunctions: number;
        slowestFunctions: PerformanceStats[];
        mostCalledFunctions: PerformanceStats[];
    } {
        const all = this.getAllStats();
        return {
            totalMetrics: all.reduce((sum, s) => sum + s.count, 0),
            uniqueFunctions: all.length,
            slowestFunctions: all.slice(0, 5),
            mostCalledFunctions: [...all].sort((a, b) => b.count - a.count).slice(0, 5)
        };
    }
}

export const performanceMonitor = new PerformanceMonitor();
