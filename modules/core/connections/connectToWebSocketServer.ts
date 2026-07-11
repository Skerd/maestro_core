/**
 * WebSocket Connection Manager (Machine-to-Machine)
 * 
 * Provides comprehensive WebSocket connection management for server-to-server communication with:
 * - Automatic retry logic with configurable retry intervals
 * - Circuit breaker pattern for failure protection and cascading failure prevention
 * - Connection lifecycle event handlers (open, close, error, ping/pong)
 * - Keep-alive mechanism with periodic ping messages
 * - Graceful shutdown handling (SIGINT, SIGTERM)
 * - Health monitoring and connection status checks
 * 
 * Connection Configuration:
 * - Host: WebSocket server host address
 * - Port: WebSocket server port
 * - Path: Connection path with machine-to-machine secret and server name
 * - RETRY_TIMER: Delay between reconnection attempts
 * 
 * Keep-Alive Mechanism:
 * - Sends MACHINE_PING message every 1000ms (1 second) when connected
 * - Responds to ping frames with pong frames
 * - Maintains connection health and detects disconnections
 * 
 * Retry Strategy:
 * - Automatically reconnects on connection close or error
 * - Waits RETRY_TIMER milliseconds between reconnection attempts
 * - Continues retrying indefinitely (critical service)
 * 
 * Circuit Breaker:
 * - Protects WebSocket operations from cascading failures
 * - Automatically opens after 5 failures within 60 seconds
 * - Resets after 30 seconds in HALF_OPEN state
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
import {WebSocketMessageCodes} from "armonia/src/modules/core/websocket/types";
import {uptimeKeeper} from "@coreModule/utilities/uptime/uptimeKeeper";

/**
 * Extended WebSocket type with keep-alive interval tracking
 */
type WebSocketType = WebSocket & { keepAliveInterval?: NodeJS.Timeout };

/** WebSocket connection instance - null until connection is established */
export let WebSocketServerLocal: WebSocketType | null = null;

/** Connection status flag - tracks if WebSocket is currently connected */
let isConnected = false;

/** Retry count for tracking connection attempts */
let retryCount = 0;

/** Flag to track if shutdown handlers have been set up (only set up once) */
let shutdownHandlersSetup = false;

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

        const handleClose = (event: { code?: number; reason?: Buffer | string }) => {
            const reason = typeof event?.reason === "string"
                ? event.reason
                : event?.reason?.toString?.() || "none";
            rejectOnce(new Error(`WebSocket closed before open. Code: ${event?.code ?? "unknown"}, Reason: ${reason}`));
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
 * 6. Uses circuit breaker protection for connection attempts
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
            void connectToWebSocketServer(parentLogger);
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
            let socket: WebSocketType | null = null;

            while (!socket) {
                try {
                    logger.debug(`Attempting WebSocket connection [${currentRetryCount + 1}/infinite]...`);
                    socket = await createSocketAndWaitForOpen(wsUrl);
                } catch (err: any) {
                    currentRetryCount++;
                    retryCount = currentRetryCount;
                    logger.err(`WebSocket connection failed: ${err.message || err.code}. Retrying in ${WEBSOCKET.RETRY_TIMER} ms.`);
                    await waitForRetry(WEBSOCKET.RETRY_TIMER);
                }
            }

            WebSocketServerLocal = socket;
            retryCount = 0;
            isConnected = true;
            shuttingDown = false;
            void uptimeKeeper.markStart("websocket");

            logger.debug(`Setting up WebSocket event handlers`);

            socket.on("ping", () => {
                socket?.pong();
            });

            socket.on("error", (error) => {
                logger.err(`WebSocket connection error. Message: ${error.message || error}.`);
                scheduleReconnectIfNeeded(socket, error.message || String(error));
            });

            socket.on("close", async (event: { code?: number; reason?: Buffer | string }) => {
                const closeLogger = getLogger("webSocketServer-closedConnection");
                const reason = typeof event?.reason === "string"
                    ? event.reason
                    : event?.reason?.toString?.() || "none";

                closeLogger.start();
                closeLogger.debug(`WebSocket connection closed. Code: ${event?.code ?? "unknown"}, Reason: ${reason}`);
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
                try {
                    if (socket && socket.readyState === WebSocket.OPEN) {
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

    if (!shutdownHandlersSetup) {
        logger.debug("Setting up SIGINT handler");
        process.on('SIGINT', async () => {
            const shutdownLogger = getLogger("webSocketServer-shutdown");
            shutdownLogger.info('Received SIGINT, closing WebSocket connection...');
            try {
                if (WebSocketServerLocal) {
                    shuttingDown = true;
                    clearKeepAlive(WebSocketServerLocal);
                    WebSocketServerLocal.close();
                    WebSocketServerLocal = null;
                    shutdownLogger.info('WebSocket connection closed successfully');
                }
            } catch (error) {
                shutdownLogger.err('Error closing WebSocket connection');
            }
            process.exit(0);
        });
        logger.debug("Finished setting up SIGINT handler");

        logger.debug("Setting up SIGTERM handler");
        process.on('SIGTERM', async () => {
            const shutdownLogger = getLogger("webSocketServer-shutdown");
            shutdownLogger.info('Received SIGTERM, closing WebSocket connection...');
            try {
                if (WebSocketServerLocal) {
                    shuttingDown = true;
                    clearKeepAlive(WebSocketServerLocal);
                    WebSocketServerLocal.close();
                    WebSocketServerLocal = null;
                    shutdownLogger.info('WebSocket connection closed successfully');
                }
            } catch (error) {
                shutdownLogger.err('Error closing WebSocket connection');
            }
            process.exit(0);
        });
        logger.debug("Finished setting up SIGTERM handler");

        shutdownHandlersSetup = true;
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
 * Clears keep-alive interval and resets connection state.
 * 
 * @example
 * ```typescript
 * await disconnectFromWebSocketServer();
 * ```
 */
export async function disconnectFromWebSocketServer(): Promise<void> {
    if (WebSocketServerLocal) {
        shuttingDown = true;
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
export function isWebSocketConnected(): boolean {
    return isConnected && WebSocketServerLocal !== null && WebSocketServerLocal.readyState === WebSocket.OPEN;
}

/**
 * Execute WebSocket operation with circuit breaker protection
 * 
 * Wraps any WebSocket operation with the circuit breaker pattern to prevent
 * cascading failures. When the circuit is open, operations fail fast without
 * attempting to reach WebSocket server.
 * 
 * Circuit Breaker States:
 * - CLOSED: Normal operation, operations pass through
 * - OPEN: Circuit is open, operations fail fast (service is down)
 * - HALF_OPEN: Testing recovery, allows limited operations
 * 
 * @param operation - WebSocket operation to execute (async function)
 * @returns Result of the operation
 * @throws Error if circuit is open or operation fails
 * 
 * @example
 * ```typescript
 * // Wrap a WebSocket send operation
 * await executeWithCircuitBreaker(async () => {
 *   if (WebSocketServerLocal) {
 *     WebSocketServerLocal.send(JSON.stringify({ code: 'MESSAGE' }));
 *   }
 * });
 * ```
 */
export async function executeWithCircuitBreaker<T>(
    operation: () => Promise<T>
): Promise<T> {
    return await webSocketCircuitBreaker.execute(operation);
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
        url: WebSocketServerLocal?.url,
        circuitBreaker: circuitBreakerStats 
    };
}

/**
 * Get WebSocket circuit breaker statistics
 * 
 * Returns the current state and statistics of the WebSocket circuit breaker,
 * useful for monitoring and debugging.
 * 
 * @returns Circuit breaker statistics including:
 * - state: Current circuit state (CLOSED, OPEN, HALF_OPEN)
 * - failures: Current failure count
 * - successes: Current success count (in HALF_OPEN state)
 * - totalRequests: Total requests processed
 * - totalFailures: Total failures encountered
 * - totalSuccesses: Total successful operations
 * 
 * @example
 * ```typescript
 * const stats = getWebSocketCircuitBreakerStats();
 * if (stats.state === 'OPEN') {
 *   console.warn('WebSocket circuit breaker is OPEN - service unavailable');
 * }
 * ```
 */
export function getWebSocketCircuitBreakerStats() {
    return webSocketCircuitBreaker.getStats();
}

/**
 * Check if WebSocket circuit breaker is open
 * 
 * Quick check to determine if the circuit breaker is currently open,
 * which means WebSocket operations will fail fast.
 * 
 * @returns true if circuit is open, false otherwise
 * 
 * @example
 * ```typescript
 * if (isWebSocketCircuitBreakerOpen()) {
 *   return { error: 'WebSocket temporarily unavailable' };
 * }
 * ```
 */
export function isWebSocketCircuitBreakerOpen(): boolean {
    return webSocketCircuitBreaker.isOpen();
}

/**
 * Manually reset the WebSocket circuit breaker
 * 
 * Resets the circuit breaker to CLOSED state, clearing all failure counts.
 * Use with caution - only reset if you're certain the service has recovered.
 * 
 * @example
 * ```typescript
 * // After confirming WebSocket server is back online
 * resetWebSocketCircuitBreaker();
 * ```
 */
export function resetWebSocketCircuitBreaker(): void {
    webSocketCircuitBreaker.reset();
}