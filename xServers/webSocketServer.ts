/**
 * WebSocket Server Entry Point
 *
 * Standalone WebSocket server for real-time client communication and the home of
 * the realtime performance monitor.
 *
 * Responsibilities:
 *   - Run the WebSocket server and broadcast presence-backed stats updates.
 *   - Reset stale users' online flags on boot.
 *   - Connect to Mongo, Redis, Kafka (producer for accurate kafka health in this process).
 *   - Hydrate cross-process counters and room message counts before accepting connections.
 *   - Live `ServerStats` pushes merge Redis-published endpoint aggregates (same snapshot as
 *     REST `/auxiliary/stats`) with in-process WebSocket room/user state — not an isolated
 *     copy of `MetricsAggregator`, which lives in the Kafka server process.
 *   - Health snapshots published to Redis for cross-process REST health reads.
 *
 * @module xServers/webSocketServer
 */

import mongoose from "mongoose";
import {CronJob} from "cron";
import {WebSocketServer} from "ws";

import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {connectToMongoDb, getMongoDbHealth} from "@coreModule/connections/connectToMongoDb";
import {connectToRedis, getRedisHealth, redisGet, redisSetEx} from "@coreModule/connections/connectToRedis";
import {connectToKafka, getKafkaHealth} from "@coreModule/connections/connectToKafka";
import {getTelegramHealthResolved} from "@coreModule/connections/connectToTelegram";

import {
    AllRoomsUsers,
    AllUsersWebSockets,
    getLocalWebSocketServerHealth,
    hydrateKnownRoomsFromStore,
    Room,
    RoomCode,
    ServerWebSocket,
    updateWebSocketInstance,
    webSocketOnNewConnection
} from "@coreModule/websocket/webSocket";
import User from "@coreModule/database/schemas/user/user";

import {SERVER, WEBSOCKET} from "@coreModule/environment";
import {
    ServerHealthFormResponseType
} from "armonia/src/modules/core/api/auxiliary/private/serverHealth/serverHealth.dto";
import {ServerStatsDto} from "armonia/src/modules/core/api/auxiliary/private/serverStats/serverStats.dto";

import {uptimeKeeper} from "@coreModule/utilities/uptime/uptimeKeeper";
import {metricsAggregator} from "@coreModule/utilities/timing/metricsAggregator";
import {STATS_SNAPSHOT_KEY, StatsSnapshotEnvelope} from "@coreModule/utilities/timing/statsSnapshotPublisher";
import {HEALTH_SNAPSHOT_KEY, HEALTH_SNAPSHOT_TTL_SECONDS} from "@coreModule/utilities/timing/healthSnapshot";
import {
    hydrateAllServiceCounters,
    startServiceCountersFlush,
    webSocketCounter
} from "@coreModule/utilities/serviceMetrics/serviceCounters";
import {hydrateRoomMessages, saveRoomMessages} from "@coreModule/utilities/serviceMetrics/wsMessageStore";
import {startServerHealthSnapshotting} from "@coreModule/utilities/timing/serverHealthHistory";
import {getAssistantResponderHealth} from "@coreModule/domain/ai/assistantHealth";
import {getCronSchedulerHealth} from "@coreModule/cronjobs/health/cronSchedulerHealth";
import {getApiServerHealth} from "@coreModule/api/health/apiServerHealth";
import {getKafkaServerHealth} from "@coreModule/kafka/kafkaServerHealth";

mongoose.set("strictQuery", true);
global.ServerName = "WebSocketServer";

/**
 * Cadences for the live broadcasters. Health broadcasts are cheap (read-only
 * memory + Redis ping); stats broadcasts include a digest of the in-memory
 * aggregator so they run a touch slower.
 */
const HEALTH_BROADCAST_CRON = "*/2 * * * * *"; // every 2s
const STATS_BROADCAST_CRON = "*/5 * * * * *";  // every 5s

let serverHealthBroadcaster: CronJob | null = null;
let serverStatsBroadcaster: CronJob | null = null;

/**
 * Sets the process timezone to UTC. Critical because every persisted timestamp
 * (1m buckets, uptime ledger, ApiAccess) is keyed off `Date.now()` and must
 * align across processes.
 */
function updateServerConfiguration(parentLogger?: serverLogger): void {
    const logger = getLogger("serverConfigurationUpdater", parentLogger);
    logger.start("Updating server configuration...");
    logger.debug(`Physical server is at: ${new Date().toString()}`);
    process.env.TZ = "UTC";
    logger.debug(`Server is set to: ${new Date().toString()}`);
    logger.finish("Finished updating server configuration!");
}

/**
 * Sends data to all WebSocket clients subscribed to the given room.
 *
 * Uses the `{code, payload}` envelope shape the FE evaluator already expects
 * (see `withWebSocket.tsx`). Per-room message counters are incremented for
 * the user activity panel.
 */
export function sendOnlineData(code: string, payload: unknown, room: string): void {
    const targetRoom = AllRoomsUsers[room];
    if (!targetRoom) return;

    const serialized = JSON.stringify({ code, payload });
    for (const userWebSockets of Object.values(AllUsersWebSockets)) {
        for (const ws of userWebSockets) {
            if (ws.readyState !== 1) continue;
            if (!ws.rooms?.includes(room)) continue;
            try {
                ws.send(serialized);
                targetRoom.messages++;
                // Each successful send is also a "completed job" for the
                // websocket service, persisted via the cross-process counter
                // so the dashboard's KPI tile survives restarts.
                webSocketCounter.recordSuccess(0);
            }
            catch (err: any) {
                webSocketCounter.recordFailure(0);
                getLogger("sendOnlineData").err(`Failed to send online data to user: ${err?.message}`);
            }
        }
    }
}

/**
 * Binds a `ws.WebSocketServer` to the given port and resolves only once it is
 * actually listening. Rejects if the bind fails (e.g. EADDRINUSE).
 *
 * IMPORTANT: `new WebSocketServer({ port })` does NOT throw synchronously when
 * the port is already in use. The error is reported via the asynchronous
 * `error` event on the underlying http server. A naive try/catch around the
 * constructor therefore reports success while the bind is silently failing.
 *
 * This helper bridges the two-event lifecycle ("listening" vs "error") into a
 * single Promise so the caller's await/retry loop works correctly.
 */
function listenWebSocketServer(port: number): Promise<WebSocketServer> {
    return new Promise((resolve, reject) => {
        const wss = new WebSocketServer({ port });
        const onError = (err: Error) => {
            wss.off("listening", onListening);
            // Best-effort cleanup so we don't leak a half-bound underlying http server.
            try { wss.close(); }
            catch { /* ignore */ }
            reject(err);
        };
        const onListening = () => {
            wss.off("error", onError);
            resolve(wss);
        };
        wss.once("error", onError);
        wss.once("listening", onListening);
    });
}

/**
 * Opens the WebSocket server instance with infinite retries (critical service).
 *
 * Retries every `WEBSOCKET.RETRY_TIMER` ms on bind failure. EADDRINUSE is the
 * common case in dev (orphan from previous hot-reload) and clears within
 * seconds once the prior process releases the port.
 */
async function openWebSocketServer(parentLogger?: serverLogger): Promise<void> {
    const logger = getLogger("creatingWebSocketServerInstance", parentLogger);
    logger.start(`Binding WebSocket server to port ${WEBSOCKET.PORT}`);

    while (true) {
        try {
            const wss = await listenWebSocketServer(WEBSOCKET.PORT);
            updateWebSocketInstance(wss);
            wss.on("connection", webSocketOnNewConnection);
            // Permanent error handler installed AFTER successful bind so any
            // future runtime errors (network blips, malformed clients, …) are
            // logged instead of crashing the process.
            wss.on("error", (err: Error) => {
                logger.err(`WebSocket server runtime error: ${err?.message}`);
            });
            logger.finish(`WebSocket server listening on :${WEBSOCKET.PORT}`);
            return;
        }
        catch (e: any) {
            logger.err(
                `Could not bind WebSocket server on :${WEBSOCKET.PORT}: ${e?.message}. ` +
                `Retrying in ${WEBSOCKET.RETRY_TIMER}ms. ` +
                `If this persists, identify the holder with: lsof -nP -iTCP:${WEBSOCKET.PORT} -sTCP:LISTEN`
            );
            await new Promise((resolve) => setTimeout(resolve, WEBSOCKET.RETRY_TIMER));
        }
    }
}

/**
 * Closes the WebSocket server gracefully on shutdown signals so the OS
 * releases the port before the next process boot. Without this, dev
 * hot-reloads frequently leave the port in TIME_WAIT for tens of seconds.
 *
 * Idempotent (multiple signals just no-op after the first).
 */
let shuttingDown = false;
function setupGracefulShutdown(parentLogger?: serverLogger): void {
    const logger = getLogger("ws_graceful_shutdown", parentLogger);
    const shutdown = (signal: string) => {
        if (shuttingDown) return;
        shuttingDown = true;
        logger.warn(`Received ${signal}; closing WebSocket server...`);

        const exit = (code: number) => {
            // Stop the cron broadcasters so timers don't keep the loop alive.
            stopBroadcasters();
            process.exit(code);
        };

        if (!ServerWebSocket) return exit(0);

        // Force-exit ceiling: if `close()` doesn't fire its callback within
        // 3 seconds (rare but possible if a client refuses to disconnect),
        // bail out anyway so the OS releases the FD.
        const forceExit = setTimeout(() => {
            logger.warn("WebSocket close timed out; forcing exit");
            exit(0);
        }, 3000);

        ServerWebSocket.close(() => {
            clearTimeout(forceExit);
            logger.warn("WebSocket server closed; exiting");
            exit(0);
        });
    };

    process.once("SIGINT",  () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));
    process.once("SIGHUP",  () => shutdown("SIGHUP"));
}

/**
 * Returns true if the given room currently has at least one subscriber.
 * Used to gate broadcasters so we never produce traffic when nobody is watching.
 */
function roomHasSubscribers(room: Room): boolean {
    const r = AllRoomsUsers[room];
    return !!r && r.users.length > 0;
}

/**
 * Sets up the WebSocket server.
 *
 * Initialization order matters:
 *  1. Mongo (required for everything else).
 *  2. Hydrate UptimeKeeper from Mongo so first health response is accurate.
 *  3. Open WS server.
 *  4. Reset users' online flag.
 *  5. Connect Redis (snapshot publisher needs it).
 *  6. Connect Kafka producer + start metrics consumer (needs Kafka).
 *  7. Mark this process as started for the "websocketServer" service.
 *  8. Start aggregator + persistence + snapshot publisher + rollup crons.
 *  9. Start uptime heartbeat.
 *  10. Start the WS broadcasters.
 */
async function setWebSocketServerUp(logger: serverLogger): Promise<void> {

    // Install signal handlers as the first thing so even an early Mongo/Redis
    // failure can be Ctrl+C'd cleanly without leaking the (yet-to-be-bound) port.
    setupGracefulShutdown(logger);

    logger.debug(`Connecting to mongoDB instance`);
    await connectToMongoDb(logger, false);
    logger.debug(`Connected to mongoDB instance`);

    logger.debug(`Hydrating UptimeKeeper from ledger`);
    await uptimeKeeper.hydrate();

    // Reset stale "online: true" flags from any previous run before we open the
    // WS server; otherwise the first health snapshot would report stale users
    // that aren't actually connected.
    await User.updateMany({ online: true }, { $set: { online: false }});

    logger.debug(`Connecting to Redis (best-effort)`);
    try {
        await connectToRedis(logger);
    }
    catch (err: any) {
        logger.warn(`Redis connect failed in WS process; snapshot publisher will retry: ${err?.message}`);
    }

    // Hydrate cross-process counters (kafka/redis/websocket/...) and the
    // per-room message counters from Redis BEFORE we open the WS server.
    // Otherwise a fast-reconnecting client could create a room entry seeded
    // with `messages: 0` instead of the persisted historical value.
    await hydrateAllServiceCounters();
    await hydrateRoomMessages();
    hydrateKnownRoomsFromStore();
    startServiceCountersFlush();

    logger.debug(`Opening websocket server instance`);
    await openWebSocketServer(logger);

    await User.updateMany({ online: true }, { $set: { online: false }});

    // Connect the Kafka producer in this process. Strictly speaking the metrics
    // consumer doesn't need the producer, but `getKafkaHealth()` reads the
    // local producer's connection state — without this call the WS broadcaster
    // would always report "kafka offline" to subscribed clients.
    logger.debug(`Connecting Kafka producer (best-effort)`);
    try {
        await connectToKafka(logger);
    }
    catch (err: any) {
        logger.warn(`Kafka producer connect failed in WS process; health getter will report offline until reconnect: ${err?.message}`);
    }

    void uptimeKeeper.markStart("websocketServer", SERVER.API_VERSION || "1.0.0");
    uptimeKeeper.start();

    logger.debug(`Starting aggregator + persistence + snapshot publisher`);
    // metricsAggregator.start();
    // startPerformancePersistence();
    // startStatsSnapshotPublisher();
    // startPerformanceRollupJobs(logger);
    startServerHealthSnapshotting(getHealthData, logger);
    // startServerHealthRollupJobs(logger);
}

const initLogger = getLogger("webSocketServerInitialization");
initLogger.start("Setting up websocket server");

initLogger.debug("Updating server configuration");
updateServerConfiguration(initLogger);
initLogger.debug("Finished updating server configuration");

setWebSocketServerUp(initLogger)
    .then(() => {
        initLogger.finish(`Done setting up websocket server!`);

        // Live broadcasters — gated by room presence for the *push*, but the
        // health snapshot is always written to Redis so the REST endpoint can
        // surface the WS server's authoritative view of `services.websocket`.
        serverHealthBroadcaster = new CronJob(HEALTH_BROADCAST_CRON, async () => {
            try {
                const data = await getHealthData();
                const statusCode =
                    data.status === "ok" ? 200 :
                    data.status === "degraded" ? 200 :
                    503;
                // Always publish so the REST `/auxiliary/health` endpoint reads
                // the WS-authoritative envelope across processes.
                void redisSetEx(
                    HEALTH_SNAPSHOT_KEY,
                    HEALTH_SNAPSHOT_TTL_SECONDS,
                    JSON.stringify({ statusCode, payload: data })
                );
                if (roomHasSubscribers(Room.SERVER_HEALTH)) {
                    sendOnlineData(RoomCode.SERVER_HEALTH, data, Room.SERVER_HEALTH);
                }
            }
            catch (err: any) {
                getLogger("serverHealthBroadcaster").err(`Error in server health broadcaster: ${err?.message}`);
            }
        }, null, true, "UTC");

        serverStatsBroadcaster = new CronJob(STATS_BROADCAST_CRON, async () => {
            // Persist per-room message counters every stats tick so refreshes
            // and restarts can re-read the cumulative count.
            void saveRoomMessages(AllRoomsUsers as Record<string, { messages: number }>);

            if (!roomHasSubscribers(Room.SERVER_STATS)) return;
            try {
                const data = await getStatsData();
                sendOnlineData(RoomCode.SERVER_STATS, data, Room.SERVER_STATS);
            }
            catch (err: any) {
                getLogger("serverStatsBroadcaster").err(`Error in server stats broadcaster: ${err?.message}`);
            }
        }, null, true, "UTC");
    })
    .catch((err) => {
        initLogger.fail(`Failed setting up server: ${err?.message}`);
    });

/**
 * Build the live ServerHealth payload broadcast to the `serverHealth` room.
 *
 * Reads the cheap in-memory health getters; the same data is what the
 * `/auxiliary/health` endpoint returns. Caches into Redis for the REST
 * endpoint to share.
 */
export async function getHealthData(): Promise<ServerHealthFormResponseType> {
    try {
        const [mongoDbHealth, redisHealth, kafkaHealth, telegramHealth, assistantHealth, cronSchedulerHealth, apiServerHealth, kafkaServerHealth] = await Promise.all([
            getMongoDbHealth(),
            getRedisHealth(),
            getKafkaHealth(),
            getTelegramHealthResolved(),
            getAssistantResponderHealth(),
            getCronSchedulerHealth(),
            getApiServerHealth(),
            getKafkaServerHealth(),
        ]);
        // Use the *local* WS server health — this process owns the WSS instance
        // and the room/user registries. The M2M client getter from
        // connectToWebSocketServer would always report `connected: false` here
        // because the WS server doesn't connect to itself.
        const webSocketHealth = getLocalWebSocketServerHealth();

        const criticalServicesHealthy =
            mongoDbHealth.connected &&
            redisHealth.connected &&
            (kafkaHealth.enabled ? kafkaHealth.connected : true);

        return {
            status: criticalServicesHealthy ? "ok" : "degraded",
            timestamp: Date.now(),
            version: SERVER.API_VERSION || "1.0.0",
            services: {
                mongoDb: mongoDbHealth,
                redis: redisHealth,
                kafka: kafkaHealth,
                websocket: webSocketHealth,
                telegram: telegramHealth,
                assistant: assistantHealth,
                cronScheduler: cronSchedulerHealth,
                apiServer: apiServerHealth,
                kafkaServer: kafkaServerHealth,
            }
        };
    }
    catch (error: any) {
        getLogger("getHealthData").err(`Failed to get health data: ${error?.message}`);
        return {
            status: "error",
            timestamp: Date.now(),
            version: SERVER.API_VERSION || "1.0.0",
            error: error?.message || "An error occurred while performing health check"
        };
    }
}

/**
 * Build the live ServerStats payload broadcast to the `serverStats` room.
 *
 * Endpoint performance samples are aggregated inside the **Kafka server**
 * process (`api_access` → `metricsAggregator`). That process publishes a
 * periodic digest to Redis (`STATS_SNAPSHOT_KEY`). The REST `/auxiliary/stats`
 * endpoint reads that snapshot — but **this** WebSocket process has its own
 * empty `metricsAggregator` instance, so a naive `digest()` here would wipe the
 * UI every time we push live updates.
 *
 * We therefore prefer the Redis snapshot (same source of truth as REST) and
 * only attach WebSocket presence from this process (`AllUsersWebSockets` /
 * `AllRoomsUsers`). Falls back to in-memory `digest()` when Redis is cold.
 */
export async function getStatsData(): Promise<ServerStatsDto> {
    const webSocketStats = {
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

    try {
        const raw = await redisGet(STATS_SNAPSHOT_KEY);
        if (raw) {
            try {
                const envelope = JSON.parse(raw) as StatsSnapshotEnvelope;
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
                    },
                    websocket: webSocketStats
                };
            }
            catch {
                /* fall through */
            }
        }

        const digest = metricsAggregator.digest("5m", 20);

        return {
            timestamp: new Date().toISOString(),
            summary: {
                totalMetrics: digest.totalRequests,
                uniqueEndpoints: digest.uniqueEndpoints,
                totalEndpointsTracked: digest.uniqueEndpoints
            },
            endpoints: {
                slowest: digest.slowest.map(toEndpointStat),
                mostCalled: digest.mostCalled.map(toEndpointStat),
                highestErrorRate: digest.highestErrorRate.map(toEndpointStat),
                all: digest.all.map(toEndpointStat)
            },
            websocket: webSocketStats
        };
    }
    catch (error: any) {
        getLogger("getStatsData").err(`Failed to get stats data: ${error?.message}`);
        return {
            timestamp: new Date().toISOString(),
            summary: { totalMetrics: 0, uniqueEndpoints: 0, totalEndpointsTracked: 0 },
            endpoints: { slowest: [], mostCalled: [], highestErrorRate: [], all: [] },
            websocket: webSocketStats,
            error: error?.message || "An error occurred while collecting statistics"
        };
    }
}

function toEndpointStat(s: ReturnType<typeof metricsAggregator.snapshot>[number]) {
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

/**
 * Stop hooks — invoked by graceful-shutdown signal handlers if/when needed.
 * Currently exported for unit-test cleanup; the process simply exits in prod.
 */
export function stopBroadcasters(): void {
    serverHealthBroadcaster?.stop();
    serverHealthBroadcaster = null;
    serverStatsBroadcaster?.stop();
    serverStatsBroadcaster = null;
}
