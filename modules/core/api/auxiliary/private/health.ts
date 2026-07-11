/**
 * Health Check Endpoint — `/auxiliary/health`.
 *
 * Returns a `ServerHealthFormResponseType` describing the current state of every
 * monitored service (Mongo, Redis, Kafka, WS, Telegram).
 *
 * Caches the most recent build into Redis for 1 second so that bursts of
 * health checks (e.g. from the live broadcaster, the FE first paint, and a
 * load-balancer probe arriving simultaneously) do not all hit the underlying
 * health getters in parallel.
 *
 * @module endpoints/auxiliary/private/health
 */

import {Request, Response, Router} from "express";
import {SERVER} from "@coreModule/environment";
import {getLogger} from "@coreModule/loggers/serverLog";
import {getMongoDbHealth} from "@coreModule/connections/connectToMongoDb";
import {getRedisHealth, redisGet, redisSetEx} from "@coreModule/connections/connectToRedis";
import {getKafkaHealth} from "@coreModule/connections/connectToKafka";
import {getWebSocketHealth} from "@coreModule/connections/connectToWebSocketServer";
import {getTelegramHealthResolved} from "@coreModule/connections/connectToTelegram";
import {getAssistantResponderHealth} from "@coreModule/domain/ai/assistantHealth";
import {getCronSchedulerHealth} from "@coreModule/cronjobs/health/cronSchedulerHealth";
import {getApiServerHealth} from "@coreModule/api/health/apiServerHealth";
import {ServerHealthDto} from "armonia/src/modules/core/api/auxiliary/private/serverHealth/serverHealth.dto";
import {HEALTH_SNAPSHOT_KEY} from "@coreModule/utilities/timing/healthSnapshot";
import ServerHealth1m from "@coreModule/database/schemas/performance/serverHealth/serverHealth1m";
import ServerHealth1h from "@coreModule/database/schemas/performance/serverHealth/serverHealth1h";
import ServerHealth1d from "@coreModule/database/schemas/performance/serverHealth/serverHealth1d";
import {
    ServerHealthHistoryDto,
    ServerHealthHistoryGranularity,
    ServerHealthHistoryPoint,
    ServerHealthHistoryServiceName
} from "armonia/src/modules/core/api/auxiliary/private/serverHealth/serverHealthHistory.dto";

const router = Router();
const logger = getLogger("health_endpoint");

/**
 * Local cache TTL when this process built the response itself (cache miss
 * fallback path). 1s mirrors the previous behaviour so simultaneous probes
 * don't stampede the underlying getters.
 */
const LOCAL_FALLBACK_TTL_SECONDS = 1;

router.get("", async (_req: Request, res: Response): Promise<void> => {
    try {
        const cached = await safeGetCachedHealth();
        if (cached) {
            res.status(cached.statusCode).json(cached.payload);
            return;
        }

        const [mongoDbHealth, redisHealth, kafkaHealth, telegramHealth, cronSchedulerHealth, assistantHealth, apiServerHealth] = await Promise.all([
            getMongoDbHealth(),
            getRedisHealth(),
            getKafkaHealth(),
            getTelegramHealthResolved(),
            getCronSchedulerHealth(),
            getAssistantResponderHealth(),
            getApiServerHealth(),
        ]);
        const webSocketHealth = getWebSocketHealth();

        const criticalServicesHealthy =
            mongoDbHealth.connected &&
            redisHealth.connected &&
            (kafkaHealth.enabled ? kafkaHealth.connected : true);

        const health: ServerHealthDto = {
            status: criticalServicesHealthy ? "ok" : "degraded",
            timestamp: Date.now(),
            version: SERVER.API_VERSION || "1.0.0",
            services: {
                mongoDb: mongoDbHealth,
                redis: redisHealth,
                kafka: kafkaHealth,
                websocket: webSocketHealth,
                telegram: telegramHealth,
                cronScheduler: cronSchedulerHealth,
                assistant: assistantHealth,
                apiServer: apiServerHealth,
            }
        };

        const statusCode = criticalServicesHealthy ? 200 : 200;
        await safeSetCachedHealth(health, statusCode);

        res.status(statusCode).json(health);
    }
    catch (error: any) {
        logger.err(`Failed to perform health check: ${error?.message}`, {
            error: error?.message,
            stack: error?.stack
        });
        res.status(503).json({
            status: "error",
            timestamp: Date.now(),
            version: SERVER.API_VERSION || "1.0.0",
            error: error?.message || "An error occurred while performing health check",
            message: "Health check service is temporarily unavailable. Please try again later."
        });
    }
});

/**
 * Reads the cached health envelope. Returns `null` on any miss/error so the
 * caller can fall back to a fresh build.
 *
 * The envelope is published by the WS server broadcaster (authoritative source —
 * it owns the live WebSocket server) and is cross-process visible. On miss this
 * process builds its own response from local getters; that path uses the M2M
 * client view of the WS server, which is acceptable as a fallback.
 */
async function safeGetCachedHealth(): Promise<{ statusCode: number; payload: ServerHealthDto } | null> {
    try {
        const raw = await redisGet(HEALTH_SNAPSHOT_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as { statusCode: number; payload: ServerHealthDto };
        if (!parsed?.payload) return null;
        // Refresh the timestamp so consumers don't perceive cached data as stale.
        parsed.payload.timestamp = Date.now();
        // WS-authored envelope may still carry process-local telegram: offline; overlay Redis/API truth.
        // Cron + assistant + apiServer also live outside the WS process — refresh from Redis heartbeats.
        if (parsed.payload.services) {
            const [telegramHealth, cronSchedulerHealth, assistantHealth, apiServerHealth] = await Promise.all([
                getTelegramHealthResolved(),
                getCronSchedulerHealth(),
                getAssistantResponderHealth(),
                getApiServerHealth(),
            ]);
            parsed.payload.services.telegram = telegramHealth;
            parsed.payload.services.cronScheduler = cronSchedulerHealth;
            parsed.payload.services.assistant = assistantHealth;
            parsed.payload.services.apiServer = apiServerHealth;
        }
        return parsed;
    }
    catch {
        return null;
    }
}

async function safeSetCachedHealth(payload: ServerHealthDto, statusCode: number): Promise<void> {
    try {
        // On API-server fallback we cache for a short window only to coalesce
        // concurrent probes; the WS server overwrites with the longer-TTL 
        // authoritative snapshot on its next tick.
        await redisSetEx(HEALTH_SNAPSHOT_KEY, LOCAL_FALLBACK_TTL_SECONDS, JSON.stringify({ statusCode, payload }));
    }
    catch {
        // Cache is best-effort; failures must not propagate to the caller.
    }
}

// ============================================================================
// Historical Health — `/auxiliary/health/history`
// ============================================================================

/**
 * Window definitions, mapped to the appropriate time-series collection.
 *
 * Choices:
 *  - 60m  -> serverHealth1m  (one row per minute, last hour)
 *  - 24h  -> serverHealth1h  (one row per hour, last day)
 *  - 7d   -> serverHealth1h  (one row per hour, last week — 168 rows is fine)
 *  - 30d  -> serverHealth1d  (one row per day, last 30 days)
 *  - 90d  -> serverHealth1d  (one row per day, last 90 days)
 *  - 365d -> serverHealth1d  (one row per day, last year — capped at TTL)
 */
const HISTORY_WINDOW_DEFINITIONS: Record<string, { granularity: ServerHealthHistoryGranularity; durationMs: number }> = {
    "60m": { granularity: "1m", durationMs: 60 * 60 * 1_000 },
    "24h": { granularity: "1h", durationMs: 24 * 60 * 60 * 1_000 },
    "7d":  { granularity: "1h", durationMs: 7 * 24 * 60 * 60 * 1_000 },
    "30d": { granularity: "1d", durationMs: 30 * 24 * 60 * 60 * 1_000 },
    "90d": { granularity: "1d", durationMs: 90 * 24 * 60 * 60 * 1_000 },
    "365d": { granularity: "1d", durationMs: 365 * 24 * 60 * 60 * 1_000 }
};

const SERVICE_NAMES: ServerHealthHistoryServiceName[] = ["mongoDb", "redis", "kafka", "websocket", "telegram", "assistant", "cronScheduler", "apiServer"];

/**
 * Returns historical health time-series for all services.
 *
 * Query params:
 *  - `window` (string): one of "60m", "24h", "7d", "30d", "90d", "365d".
 *    Defaults to "60m".
 *
 * Response:
 *  - `granularity`: bucket size used for the response ("1m" | "1h" | "1d").
 *  - `from`, `to`: ISO timestamps bounding the query window.
 *  - `series`: one entry per service, each with an array of bucket points.
 */
router.get("/history", async (req: Request, res: Response): Promise<void> => {
    try {
        const windowParam = String(req.query.window || "60m").toLowerCase();
        const definition = HISTORY_WINDOW_DEFINITIONS[windowParam] || HISTORY_WINDOW_DEFINITIONS["60m"];

        const now = Date.now();
        const from = new Date(now - definition.durationMs);
        const to = new Date(now);

        const points = await readHistorySeries(definition.granularity, from, to);

        const series = SERVICE_NAMES.map((service) => ({
            service,
            points: points.filter((p) => p.service === service).map(stripService)
        }));

        const response: ServerHealthHistoryDto = {
            granularity: definition.granularity,
            from: from.toISOString(),
            to: to.toISOString(),
            series
        };

        res.status(200).json(response);
    }
    catch (error: any) {
        logger.err(`Failed to read health history: ${error?.message}`, {
            error: error?.message,
            stack: error?.stack
        });
        res.status(500).json({
            error: "history_unavailable",
            message: error?.message || "Failed to read health history"
        });
    }
});

type SeriesPoint = ServerHealthHistoryPoint & { service: ServerHealthHistoryServiceName };

function stripService(p: SeriesPoint): ServerHealthHistoryPoint {
    const { service: _service, ...rest } = p;
    return rest;
}

/**
 * Reads + normalizes one of the three time-series collections into the
 * response shape. The 1m collection's `up` (0/1) becomes `uptimePct`
 * directly; the rollup collections already store `uptimePct`.
 */
async function readHistorySeries(
    granularity: ServerHealthHistoryGranularity,
    from: Date,
    to: Date
): Promise<SeriesPoint[]> {
    if (granularity === "1m") {
        const rows = await ServerHealth1m
            .find({ bucketStart: { $gte: from, $lt: to } })
            .sort({ bucketStart: 1 })
            .lean();
        return rows.map((r: any) => ({
            service: r.meta.service,
            bucketStart: new Date(r.bucketStart).toISOString(),
            uptimePct: r.up ? 1 : 0,
            breakerOpenSamples: r.circuitBreakerState === "OPEN" ? 1 : 0,
            completedJobs: r.completedJobsDelta || 0,
            failedJobs: r.failedJobsDelta || 0,
            averageTime: r.averageTime || 0
        }));
    }

    const Model = granularity === "1h" ? ServerHealth1h : ServerHealth1d;
    const rows = await Model
        .find({ bucketStart: { $gte: from, $lt: to } })
        .sort({ bucketStart: 1 })
        .lean();
    return rows.map((r: any) => ({
        service: r.meta.service,
        bucketStart: new Date(r.bucketStart).toISOString(),
        uptimePct: r.uptimePct ?? 0,
        breakerOpenSamples: r.breakerOpenSamples || 0,
        completedJobs: r.completedJobs || 0,
        failedJobs: r.failedJobs || 0,
        averageTime: r.averageTime || 0
    }));
}

export { router };
