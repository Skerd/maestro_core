/**
 * WebSocket Connection Manager (Machine-to-Machine)
 * 
 * Provides comprehensive WebSocket connection management for server-to-server communication with:
 * - Automatic retry logic with configurable retry intervals
 * - Circuit breaker pattern for failure protection and cascading failure prevention
 * - Connection lifecycle event handlers (open, close, error, pong)
 * - Keep-alive mechanism with periodic ping messages and dead-peer detection
 * - Health monitoring and connection status checks
 * 
 * Connection Configuration:
 * - Host: WebSocket server host address
 * - Port: WebSocket server port
 * - Path: Connection path with machine-to-machine secret and server name
 * - RETRY_TIMER: Delay between reconnection attempts
 * 
 * Keep-Alive Mechanism:
 * - Sends a MACHINE_PING message and a ping frame every KEEP_ALIVE_INTERVAL ms
 * - Terminates the socket when no pong arrives for 3 intervals, which triggers
 *   a reconnect (a half-open TCP connection would otherwise swallow messages)
 * 
 * Retry Strategy:
 * - Automatically reconnects on connection close or error
 * - Waits RETRY_TIMER milliseconds between reconnection attempts
 * - Continues retrying indefinitely (critical service)
 * 
 * Circuit Breaker:
 * - Every outbound message goes through {@link pushWebsocketMessage}, which
 *   runs the send through the WebSocket circuit breaker
 * - Opens after 5 failures within 60 seconds; a send slower than 5 seconds counts as a failure
 * - Lets a trial send through after 30 seconds (HALF_OPEN)
 * - Requires 2 successful operations to close from HALF_OPEN
 * 
 * @module connectToWebSocketServer
 */

import {WebSocket} from "ws";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {clearInterval} from "node:timers";
import {MACHINE_TO_MACHINE_SECRET, WEBSOCKET} from "@coreModule/environment";
import {webSocketCircuitBreaker} from "@coreModule/utilities/circuitBreaker";
import {WebSocketHealth} from "armonia/src/modules/core/api/auxiliary/private/serverHealth/serverHealth.dto";
import {WebSocketMessageCodes, WebSocketPush} from "armonia/src/modules/core/websocket/types";
import {uptimeKeeper} from "@coreModule/utilities/uptime/uptimeKeeper";

/**
 * Extended WebSocket type with keep-alive tracking
 */
type WebSocketType = WebSocket & { keepAliveInterval?: NodeJS.Timeout; lastPongAt?: number };

/** Missed keep-alive intervals after which the peer is considered dead. */
const MISSED_PONGS_BEFORE_TERMINATE = 3;

/** WebSocket connection instance - null until connection is established */
let WebSocketServerLocal: WebSocketType | null = null;

/** Connection status flag - tracks if WebSocket is currently connected */
let isConnected = false;

/** Retry count for tracking connection attempts */
let retryCount = 0;

/** Prevent overlapping initial connection attempts */
let connectInProgress = false;

/** Prevent overlapping reconnect loops after runtime disconnects */
let reconnectInProgress = false;

/** Prevent reconnect scheduling during intentional shutdown/disconnect */
let shuttingDown = false;

async function waitForRetry(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

function clearKeepAlive(socket?: WebSocketType | null): void {
    if (socket?.keepAliveInterval) {
        clearInterval(socket.keepAliveInterval);
        socket.keepAliveInterval = undefined;
    }
}

function normalizeWebSocketError(error: unknown): Error {
    if (error instanceof Error) {
        return error;
    }

    return new Error(typeof error === "string" ? error : "Unknown WebSocket error");
}

async function createSocketAndWaitForOpen(wsUrl: string): Promise<WebSocketType> {
    return await new Promise<WebSocketType>((resolve, reject) => {
        const socket = new WebSocket(wsUrl) as WebSocketType;
        let settled = false;

        const cleanup = () => {
            socket.off("open", handleOpen);
            socket.off("error", handleError);
            socket.off("close", handleClose);
        };

        const rejectOnce = (error: unknown) => {
            if (settled) {
                return;
            }

            settled = true;
            cleanup();
            clearKeepAlive(socket);

            if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
                try {
                    socket.close();
                } catch {
                    // Ignore secondary close failures while failing the handshake.
                }
            }

            reject(normalizeWebSocketError(error));
        };

        const handleOpen = () => {
            if (settled) {
                return;
            }

            settled = true;
            cleanup();
            resolve(socket);
        };

        const handleError = (error: Error) => {
            rejectOnce(error);
        };

        const handleClose = (code: number, reason: Buffer) => {
            rejectOnce(new Error(`WebSocket closed before open. Code: ${code}, Reason: ${reason.toString() || "none"}`));
        };

        socket.on("open", handleOpen);
        socket.on("error", handleError);
        socket.on("close", handleClose);
    });
}

/**
 * Establishes connection to WebSocket server with comprehensive error handling and retry logic
 * 
 * This function:
 * 1. Checks if already connected to avoid duplicate connections
 * 2. Creates WebSocket connection with machine-to-machine authentication
 * 3. Sets up event handlers for connection lifecycle (open, close, error, ping)
 * 4. Implements keep-alive mechanism with periodic ping messages
 * 5. Handles automatic reconnection on disconnect
 * 
 * Connection Path Format:
 * `ws://{HOST}:{PORT}/{MACHINE_TO_MACHINE_SECRET}/{SERVER_NAME}`
 * 
 * @param parentLogger - Optional parent logger instance for hierarchical logging
 * 
 * @example
 * ```typescript
 * // Basic connection
 * await connectToWebSocketServer();
 * 
 * // With custom logger
 * await connectToWebSocketServer(logger);
 * ```
 */
export async function connectToWebSocketServer(parentLogger?: serverLogger): Promise<void>{
    const logger = getLogger("webSocketServer-connecting", parentLogger);
    shuttingDown = false;
    const wsUrl = `ws://${WEBSOCKET.HOST}:${WEBSOCKET.PORT}/${MACHINE_TO_MACHINE_SECRET}/${global.ServerName}`;
    logger.start("Setting up WebSocket instance");
    logger.debug(`WebSocket target host=${WEBSOCKET.HOST}, port=${WEBSOCKET.PORT}, server=${global.ServerName}`);

    const reconnectWithRetry = async (): Promise<void> => {
        if (reconnectInProgress || shuttingDown) {
            return;
        }

        reconnectInProgress = true;

        try {
            logger.warn(`WebSocket disconnected. Retrying in ${WEBSOCKET.RETRY_TIMER} ms. This connection CANNOT FAIL.`);
            await waitForRetry(WEBSOCKET.RETRY_TIMER);
            if (!shuttingDown) {
                void connectToWebSocketServer(parentLogger);
            }
        } finally {
            reconnectInProgress = false;
        }
    };

    const scheduleReconnectIfNeeded = (socket: WebSocketType, reason: string): void => {
        if (shuttingDown) {
            return;
        }

        logger.warn(`WebSocket connection lost (${reason}). Scheduling reconnect supervisor.`);
        clearKeepAlive(socket);

        if (WebSocketServerLocal === socket) {
            WebSocketServerLocal = null;
        }

        isConnected = false;

        if (socket.readyState === WebSocket.OPEN) {
            socket.close();
            return;
        }

        void reconnectWithRetry().catch((err: any) => {
            logger.err(`WebSocket reconnection error. Error: ${err.message}`);
        });
    };

    const establishConnectionLoop = async (): Promise<void> => {
        connectInProgress = true;

        try {
            let currentRetryCount = retryCount;
            let opened: WebSocketType | null = null;

            while (!opened && !shuttingDown) {
                try {
                    logger.debug(`Attempting WebSocket connection [${currentRetryCount + 1}/infinite]...`);
                    opened = await createSocketAndWaitForOpen(wsUrl);
                } catch (err: any) {
                    currentRetryCount++;
                    retryCount = currentRetryCount;
                    logger.err(`WebSocket connection failed: ${err.message || err.code}. Retrying in ${WEBSOCKET.RETRY_TIMER} ms.`);
                    await waitForRetry(WEBSOCKET.RETRY_TIMER);
                }
            }

            if (!opened) {
                return;
            }
            const socket = opened;
            if (shuttingDown) {
                // Disconnected while the handshake was in flight.
                socket.close();
                return;
            }

            WebSocketServerLocal = socket;
            retryCount = 0;
            isConnected = true;
            void uptimeKeeper.markStart("websocket");

            logger.debug(`Setting up WebSocket event handlers`);

            // ws answers the server's ping frames automatically; the pongs
            // tracked here answer our own pings (see the keep-alive below).
            socket.lastPongAt = Date.now();
            socket.on("pong", () => {
                socket.lastPongAt = Date.now();
            });

            socket.on("error", (error) => {
                logger.err(`WebSocket connection error. Message: ${error.message || error}.`);
                scheduleReconnectIfNeeded(socket, error.message || String(error));
            });

            socket.on("close", async (code: number, reason: Buffer) => {
                const closeLogger = getLogger("webSocketServer-closedConnection");

                closeLogger.start();
                closeLogger.debug(`WebSocket connection closed. Code: ${code}, Reason: ${reason.toString() || "none"}`);
                closeLogger.debug(`WebSocket connection cannot remain closed. Reconnecting...`);
                closeLogger.finish();

                clearKeepAlive(socket);

                if (WebSocketServerLocal === socket) {
                    WebSocketServerLocal = null;
                }

                isConnected = false;
                retryCount++;

                if (!shuttingDown) {
                    await reconnectWithRetry();
                }
            });

            const openLogger = getLogger("webSocketServer-newOpenedConnection");
            openLogger.start();
            openLogger.debug(`WebSocket connection opened`);
            openLogger.info(`WebSocket connected`);

            socket.keepAliveInterval = setInterval(() => {
                const silentFor = Date.now() - (socket.lastPongAt ?? 0);
                if (silentFor > WEBSOCKET.KEEP_ALIVE_INTERVAL * MISSED_PONGS_BEFORE_TERMINATE) {
                    openLogger.warn(`No pong from WebSocket server for ${silentFor} ms. Terminating to reconnect.`);
                    // terminate() emits 'close', whose handler reconnects.
                    socket.terminate();
                    return;
                }
                try {
                    if (socket.readyState === WebSocket.OPEN) {
                        socket.ping();
                        socket.send(JSON.stringify({
                            code: WebSocketMessageCodes.MACHINE_TO_MACHINE_PING,
                            payload: {
                                machineName: global.ServerName
                            }
                        }));
                    }
                } catch (error: any) {
                    openLogger.err(`Failed to send keep-alive ping: ${error.message}`);
                }
            }, WEBSOCKET.KEEP_ALIVE_INTERVAL);

            openLogger.finish();
            openLogger.updateSpace(-2);
        } finally {
            connectInProgress = false;
        }
    };

    logger.debug(`Trying to connect to WebSocket host`);

    if (WebSocketServerLocal && WebSocketServerLocal.readyState === WebSocket.OPEN) {
        logger.debug("Already connected to WebSocket. Skipping reconnection.");
        logger.finish();
        return;
    }

    if (connectInProgress) {
        logger.debug("WebSocket connection attempt already in progress. Skipping duplicate connect.");
        logger.finish();
        return;
    }

    void establishConnectionLoop().catch((err: any) => {
        logger.err(`connectToWebSocketServer background supervisor failed: ${err.message}`);
    });

    logger.finish("WebSocket connection supervisor started");
    logger.updateSpace(-1);
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Disconnect from WebSocket server gracefully
 * 
 * Closes the WebSocket connection and cleans up resources.
 * Clears keep-alive interval and resets connection state, and stops any
 * pending reconnect. Called by each server's graceful shutdown.
 * 
 * @example
 * ```typescript
 * await disconnectFromWebSocketServer();
 * ```
 */
export async function disconnectFromWebSocketServer(): Promise<void> {
    shuttingDown = true;
    if (WebSocketServerLocal) {
        clearKeepAlive(WebSocketServerLocal);
        WebSocketServerLocal.close();
        WebSocketServerLocal = null;
    }
    isConnected = false;
}

/**
 * Check if WebSocket is currently connected
 * 
 * @returns true if WebSocket is connected and ready, false otherwise
 * 
 * @example
 * ```typescript
 * if (!isWebSocketConnected()) {
 *   throw new Error('WebSocket not available');
 * }
 * ```
 */
function isWebSocketConnected(): boolean {
    return isConnected && WebSocketServerLocal !== null && WebSocketServerLocal.readyState === WebSocket.OPEN;
}

/**
 * Push a message to users through the WebSocket server (machine connection).
 *
 * Fire-and-forget: a no-op while disconnected; a failed or slow send is
 * logged and counted by the WebSocket circuit breaker, and while the breaker
 * is open sends are dropped without touching the socket.
 *
 * @param message - Message code, payload and receiving user IDs, serialized as JSON
 */
export function pushWebsocketMessage<T>(message: WebSocketPush<T>): void {
    const socket = WebSocketServerLocal;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        return;
    }
    const data = JSON.stringify(message);
    webSocketCircuitBreaker.execute(() => new Promise<void>((resolve, reject) => {
        socket.send(data, (error) => (error ? reject(error) : resolve()));
    })).catch((error: any) => {
        getLogger("webSocketServer-send").warn(`Failed to send WebSocket message: ${error?.message ?? error}`);
    });
}

/**
 * Comprehensive WebSocket health check function
 * 
 * Returns connection status, connection details, and circuit breaker statistics.
 * Automatically logs warnings if circuit breaker is open.
 * 
 * @returns Health status object containing:
 * - connected: Boolean indicating if WebSocket is connected
 * - readyState: WebSocket ready state (0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED)
 * - url: WebSocket connection URL (if connected)
 * - circuitBreaker: Circuit breaker statistics and state
 * 
 * @example
 * ```typescript
 * const health = getWebSocketHealth();
 * if (!health.connected) {
 *   console.error('WebSocket is not connected!');
 * }
 * if (health.circuitBreaker?.state === 'OPEN') {
 *   console.warn('Circuit breaker is OPEN - WebSocket unavailable');
 * }
 * ```
 */
export function getWebSocketHealth(): WebSocketHealth {
    const connected = isWebSocketConnected();
    const readyState = WebSocketServerLocal?.readyState ?? null;
    const circuitBreakerStats = webSocketCircuitBreaker.getStats();

    // Warn if circuit breaker is open (service is down)
    if (circuitBreakerStats.state === 'OPEN') {
        const logger = getLogger("websocket_health_monitor");
        logger.warn?.(
            `WebSocket circuit breaker is OPEN - service unavailable`,
            {
                circuitBreaker: circuitBreakerStats
            }
        );
    }

    return {
        lastStart: uptimeKeeper.getLastStart("websocket"),
        messages: 0,
        failedJobs: 0,
        totalTime: 0,
        rooms: [], 
        users: 0,
        connected,
        readyState,
        // Not the socket URL: its path carries MACHINE_TO_MACHINE_SECRET.
        url: `ws://${WEBSOCKET.HOST}:${WEBSOCKET.PORT}`,
        circuitBreaker: circuitBreakerStats 
    };
}
