/**
 * Performance Stats Endpoint — `/auxiliary/stats`.
 *
 * Two read paths:
 *  1. Live (default): return the snapshot the WebSocket process publishes to
 *     Redis every 5s under `STATS_SNAPSHOT_KEY`. O(1) for the API server.
 *  2. Historical: when the caller passes `?window=1h|24h|7d|30d`, aggregate the
 *     matching `serverPerformance{1h|1d}` time-series collection into the same
 *     response shape.
 *
 * The previous on-demand `$facet` pipeline against `ApiAccess` is removed —
 * raw access events stay in Mongo for forensics but are no longer the source
 * of truth for stats.
 *
 * @module endpoints/auxiliary/private/stats
 */

import {Request, Response, Router} from "express";
import {getLogger} from "@coreModule/loggers/serverLog";
import {AllRoomsUsers, AllUsersWebSockets} from "@coreModule/websocket/webSocket";
import {redisGet} from "@coreModule/connections/connectToRedis";
import {STATS_SNAPSHOT_KEY, StatsSnapshotEnvelope} from "@coreModule/utilities/timing/statsSnapshotPublisher";
import ServerPerformance1h from "@coreModule/database/schemas/performance/serverPerformance/serverPerformance1h";
import ServerPerformance1d from "@coreModule/database/schemas/performance/serverPerformance/serverPerformance1d";
import {
    EndpointStatType,
    ServerStatsDto,
    StatsPaginationType
} from "armonia/src/modules/core/api/auxiliary/private/serverStats/serverStats.dto";

const router = Router();
const logger = getLogger("stats_endpoint");

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const TOP_N = 20;

type HistoricalWindow = "1h" | "24h" | "7d" | "30d";

router.get("", async (req: Request, res: Response): Promise<void> => {
    try {
        const window = parseWindow(req.query.window);
        const page = clampInt(req.query.page, 1, Number.MAX_SAFE_INTEGER, DEFAULT_PAGE);
        const limit = clampInt(req.query.limit, 1, MAX_LIMIT, DEFAULT_LIMIT);

        const webSocketStats = computeWebSocketStats();

        if (window === "live") {
            const live = await readLiveSnapshot();
            if (live) {
                res.status(200).json(buildResponse(live, webSocketStats, page, limit));
                return;
            }
            // Snapshot key absent (WS process restarting?) — fall through to historical 1h aggregate as a safe alternative.
        }

        const aggregated = await readHistoricalAggregate(window === "live" ? "1h" : window);
        res.status(200).json(buildResponse(aggregated, webSocketStats, page, limit));
    }
    catch (error: any) {
        logger.err(`Failed to get stats: ${error?.message}`, { error: error?.message, stack: error?.stack });
        res.status(500).json({
            error: "Failed to retrieve stats",
            message: "An error occurred while collecting statistics. Please try again later."
        });
    }
});

/**
 * Parses the `window` query param. Defaults to "live" when absent or invalid.
 */
function parseWindow(raw: unknown): "live" | HistoricalWindow {
    const v = String(raw ?? "live").toLowerCase();
    if (v === "live" || v === "1h" || v === "24h" || v === "7d" || v === "30d") return v as any;
    return "live";
}

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
    const n = parseInt(String(raw), 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

/**
 * Reads the latest live snapshot from Redis. Returns null when the publisher
 * hasn't written yet or Redis is down.
 */
async function readLiveSnapshot(): Promise<{
    summary: { totalMetrics: number; uniqueEndpoints: number; totalEndpointsTracked: number };
    endpoints: { slowest: EndpointStatType[]; mostCalled: EndpointStatType[]; highestErrorRate: EndpointStatType[]; all: EndpointStatType[] };
    timestamp: string;
} | null> {
    const raw = await redisGet(STATS_SNAPSHOT_KEY);
    if (!raw) return null;
    let envelope: StatsSnapshotEnvelope;
    try {
        envelope = JSON.parse(raw) as StatsSnapshotEnvelope;
    }
    catch {
        return null;
    }
    return {
        timestamp: envelope.publishedAt,
        summary: {
            totalMetrics: envelope.summary.totalRequests,
            uniqueEndpoints: envelope.summary.uniqueEndpoints,
            totalEndpointsTracked: envelope.summary.uniqueEndpoints
        },
        endpoints: {
            slowest: envelope.endpoints.slowest.map(toEndpointStat),
            mostCalled: envelope.endpoints.mostCalled.map(toEndpointStat),
            highestErrorRate: envelope.endpoints.highestErrorRate.map(toEndpointStat),
            all: envelope.endpoints.all.map(toEndpointStat)
        }
    };
}

/**
 * Aggregates the relevant time-series collection for historical windows.
 *
 *  - `1h`  -> `serverPerformance1m` (raw 1-minute buckets, last hour) — but at the
 *             API endpoint we don't have access to the WS aggregator's snapshot,
 *             so we read from `serverPerformance1h` for the most recent rollup.
 *  - `24h` -> `serverPerformance1h`, last 24 documents.
 *  - `7d`  -> `serverPerformance1d`, last 7 documents.
 *  - `30d` -> `serverPerformance1d`, last 30 documents.
 */
async function readHistoricalAggregate(window: HistoricalWindow): Promise<{
    summary: { totalMetrics: number; uniqueEndpoints: number; totalEndpointsTracked: number };
    endpoints: { slowest: EndpointStatType[]; mostCalled: EndpointStatType[]; highestErrorRate: EndpointStatType[]; all: EndpointStatType[] };
    timestamp: string;
}> {
    const now = Date.now();
    let model: typeof ServerPerformance1h | typeof ServerPerformance1d;
    let from: Date;

    switch (window) {
        case "1h":
            model = ServerPerformance1h;
            from = new Date(now - 60 * 60 * 1000);
            break;
        case "24h":
            model = ServerPerformance1h;
            from = new Date(now - 24 * 60 * 60 * 1000);
            break;
        case "7d":
            model = ServerPerformance1d;
            from = new Date(now - 7 * 24 * 60 * 60 * 1000);
            break;
        case "30d":
            model = ServerPerformance1d;
            from = new Date(now - 30 * 24 * 60 * 60 * 1000);
            break;
    }

    const docs: Array<{
        _id: { method: string; endpoint: string };
        count: number;
        errors: number;
        sum: number;
        min: number;
        max: number;
        p50Weighted: number;
        p95Weighted: number;
        p99Weighted: number;
        lastExecuted: Date;
    }> = await (model as any).aggregate([
        { $match: { bucketStart: { $gte: from } } },
        {
            $group: {
                _id: { method: "$meta.method", endpoint: "$meta.endpoint" },
                count: { $sum: "$count" },
                errors: { $sum: "$errors" },
                sum: { $sum: "$sum" },
                min: { $min: "$min" },
                max: { $max: "$max" },
                p50Weighted: { $sum: { $multiply: ["$p50", "$count"] } },
                p95Weighted: { $sum: { $multiply: ["$p95", "$count"] } },
                p99Weighted: { $sum: { $multiply: ["$p99", "$count"] } },
                lastExecuted: { $max: "$lastExecuted" }
            }
        }
    ]).exec();

    const stats: EndpointStatType[] = docs.map((d) => {
        const avg = d.count === 0 ? 0 : d.sum / d.count;
        const errorRate = d.count === 0 ? 0 : (d.errors / d.count) * 100;
        return {
            method: d._id.method,
            endpoint: d._id.endpoint,
            count: d.count,
            averageDuration: Math.round(avg),
            minDuration: d.min ?? 0,
            maxDuration: d.max ?? 0,
            p50: d.count === 0 ? 0 : Math.round(d.p50Weighted / d.count),
            p95: d.count === 0 ? 0 : Math.round(d.p95Weighted / d.count),
            p99: d.count === 0 ? 0 : Math.round(d.p99Weighted / d.count),
            errors: d.errors,
            errorRate: errorRate.toFixed(2),
            lastExecuted: (d.lastExecuted ? new Date(d.lastExecuted) : new Date()).toISOString()
        };
    });

    const slowest = [...stats].sort((a, b) => b.averageDuration - a.averageDuration).slice(0, TOP_N);
    const mostCalled = [...stats].sort((a, b) => b.count - a.count).slice(0, TOP_N);
    const highestErrorRate = stats
        .filter((s) => s.errors > 0)
        .sort((a, b) => parseFloat(b.errorRate) - parseFloat(a.errorRate))
        .slice(0, TOP_N);

    const totalMetrics = stats.reduce((acc, s) => acc + s.count, 0);
    return {
        timestamp: new Date().toISOString(),
        summary: {
            totalMetrics,
            uniqueEndpoints: stats.length,
            totalEndpointsTracked: stats.length
        },
        endpoints: { slowest, mostCalled, highestErrorRate, all: mostCalled }
    };
}

/**
 * Live websocket presence — read from the in-process WS state. Note: this only
 * reflects the API process' own view; in a multi-process deployment the real
 * websocket presence lives in the WS process. The live broadcast is the
 * authoritative source for these numbers; this read path remains for the
 * REST endpoint's structural completeness.
 */
function computeWebSocketStats(): ServerStatsDto["websocket"] {
    return {
        totalUsers: Object.keys(AllUsersWebSockets).length,
        totalConnections: Object.values(AllUsersWebSockets).reduce(
            (sum, connections) => sum + connections.length,
            0
        ),
        totalRooms: Object.keys(AllRoomsUsers).length,
        rooms: Object.values(AllRoomsUsers).map((room) => ({
            id: room.id,
            name: room.name,
            userCount: room.users.length,
            totalInstances: room.users.reduce((sum, u) => sum + u.instances, 0),
            messages: room.messages
        }))
    };
}

function toEndpointStat(s: {
    method: string;
    endpoint: string;
    count: number;
    averageDuration: number;
    minDuration: number;
    maxDuration: number;
    p50: number;
    p95: number;
    p99: number;
    errors: number;
    errorRate: number;
    lastExecuted: number;
}): EndpointStatType {
    return {
        method: s.method,
        endpoint: s.endpoint,
        count: s.count,
        averageDuration: s.averageDuration,
        minDuration: s.minDuration,
        maxDuration: s.maxDuration,
        p50: s.p50,
        p95: s.p95,
        p99: s.p99,
        errors: s.errors,
        errorRate: s.errorRate.toFixed(2),
        lastExecuted: new Date(s.lastExecuted || Date.now()).toISOString()
    };
}

function buildResponse(
    base: {
        timestamp: string;
        summary: { totalMetrics: number; uniqueEndpoints: number; totalEndpointsTracked: number };
        endpoints: { slowest: EndpointStatType[]; mostCalled: EndpointStatType[]; highestErrorRate: EndpointStatType[]; all: EndpointStatType[] };
    },
    webSocketStats: ServerStatsDto["websocket"],
    page: number,
    limit: number
): ServerStatsDto {
    const totalEndpoints = base.summary.uniqueEndpoints;
    const totalPages = Math.max(1, Math.ceil(totalEndpoints / limit));
    const offset = (page - 1) * limit;
    const allPaginated = base.endpoints.all.slice(offset, offset + limit);
    const pagination: StatsPaginationType = {
        page,
        limit,
        total: totalEndpoints,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1
    };
    return {
        timestamp: base.timestamp,
        summary: base.summary,
        endpoints: {
            slowest: base.endpoints.slowest,
            mostCalled: base.endpoints.mostCalled,
            highestErrorRate: base.endpoints.highestErrorRate,
            all: allPaginated
        },
        pagination,
        websocket: webSocketStats
    };
}

export { router };
