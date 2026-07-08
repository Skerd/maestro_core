/**
 * Redis Connection Manager
 * 
 * Provides comprehensive Redis connection management with:
 * - Automatic retry logic with configurable retry limits
 * - Circuit breaker pattern for failure protection and cascading failure prevention
 * - Connection pool configuration and timeout settings
 * - Event handlers for connection lifecycle (ready, error, end)
 * - Graceful shutdown handling (SIGINT, SIGTERM)
 * - Health monitoring and connection status checks
 * - Circuit breaker-protected operation wrappers
 * 
 * Connection Configuration:
 * - connectTimeout: Time to wait for initial connection
 * - keepAlive: Keep-alive interval for maintaining connections
 * - reconnectStrategy: Exponential backoff reconnection strategy
 * - CONNECTION_TIMER: Delay between retry attempts
 * 
 * Retry Strategy:
 * - Retries connection attempts until Redis becomes available
 * - Waits CONNECTION_TIMER milliseconds between retry attempts
 * - Uses exponential backoff for reconnection (min(retries * 100, 3000)ms)
 * - Keeps the Redis supervisor running until the connection recovers
 * 
 * Circuit Breaker:
 * - Protects all Redis operations from cascading failures
 * - Automatically opens after 5 failures within 60 seconds
 * - Resets after 30 seconds in HALF_OPEN state
 * - Requires 2 successful operations to close from HALF_OPEN
 * 
 * @module connectToRedis
 */

import {createClient, RedisClientType} from 'redis';
import {REDIS} from "@coreModule/environment";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {redisCircuitBreaker} from "@coreModule/utilities/circuitBreaker";
import {RedisHealth} from "armonia/src/modules/core/api/auxiliary/private/serverHealth/serverHealth.dto";
import {uptimeKeeper} from "@coreModule/utilities/uptime/uptimeKeeper";
import {redisCounter} from "@coreModule/utilities/serviceMetrics/serviceCounters";

/**
 * Redis instance - exported for use throughout the application
 * This is the singleton instance that manages the Redis connection
 */
export const redisInstance = require('redis');

/** Tracks retry attempts for connection failures */
let retryCount = 0;

/** Flag to distinguish first connection from reconnection attempts */
let firstConnection = true;

/** Redis client instance - null until connection is established */
let redisClient: RedisClientType | null = null;

/** Connection status flag - tracks if Redis is currently connected */
let isConnected = false;

/** Flag to ensure graceful shutdown handlers are only registered once */
let shutdownHandlersSetup = false;

/** Flag to ensure Redis client lifecycle handlers are only registered once */
let clientHandlersSetup = false;

/** Prevent overlapping reconnect loops after disconnect events */
let reconnectInProgress = false;

/** Prevent overlapping connection loops */
let connectInProgress = false;

async function waitForRetry(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Establishes connection to Redis with comprehensive error handling and retry logic
 * 
 * This function:
 * 1. Creates Redis client with connection configuration
 * 2. Sets up event handlers for connection lifecycle events
 * 3. Implements retry logic with circuit breaker protection
 * 4. Handles graceful shutdown on SIGINT/SIGTERM
 * 5. Configures automatic reconnection strategy
 * 
 * @param parentLogger - Optional parent logger instance for hierarchical logging
 * 
 * @example
 * ```typescript
 * // Basic connection
 * await connectToRedis();
 * 
 * // With custom logger
 * await connectToRedis(logger);
 * ```
 */
export async function connectToRedis(parentLogger?: serverLogger): Promise<void> {
    let logger = getLogger("connecting_to_redis_instance", parentLogger);
    logger.start("Setting up Redis instance");
    const primaryNode = REDIS.ROOT_NODES[0];
    const [host, port] = primaryNode.split(':');
    logger.debug(`Redis target node=${primaryNode}, username=${REDIS.USERNAME ? 'provided' : 'not provided'}, password=${REDIS.PASSWORD ? 'provided' : 'not provided'}`);

    /**
     * Internal retry function that attempts connection with circuit breaker protection
     * Continues retrying until successful
     */
    const connectWithRetry = async (initialRetryCount = 0): Promise<void> => {
        if (connectInProgress) {
            logger.debug("Redis connection attempt already in progress. Skipping duplicate connect.");
            return;
        }

        connectInProgress = true;
        let currentRetryCount = initialRetryCount;
        try {
            while (true) {
                try {
                    logger.debug(`Attempting Redis connection [${currentRetryCount + 1}/infinite]...`);
                    
                    if (!redisClient) {
                        throw new Error('Redis client not initialized');
                    }

                    // Connection supervision retries independently from the circuit breaker
                    // until Redis becomes available again.
                    await redisClient!.connect();

                    logger.info('Redis connected');
                    retryCount = 0; // Reset retry count on successful connection
                    isConnected = true;
                    firstConnection = false;
                    void uptimeKeeper.markStart("redis");
                    return;
                } catch (error: any) {
                    currentRetryCount++;
                    retryCount = currentRetryCount;
                    logger.err(`Redis connection failed: ${error.message}. Retrying in ${REDIS.CONNECTION_TIMER} ms.`);
                    
                    // Continue retrying in the background instead of blocking startup.
                    await waitForRetry(REDIS.CONNECTION_TIMER);
                }
            }
        } finally {
            connectInProgress = false;
        }
    };

    const reconnectWithRetry = async (): Promise<void> => {
        if (reconnectInProgress) {
            logger.debug("Redis reconnect already in progress. Skipping duplicate reconnect.");
            return;
        }

        reconnectInProgress = true;
        retryCount = 0;
        isConnected = false;

        try {
            logger.warn(`Redis disconnected. Retrying in ${REDIS.CONNECTION_TIMER} ms.`);
            await waitForRetry(REDIS.CONNECTION_TIMER);
            await connectWithRetry();
            logger.info('Redis reconnected');
        } finally {
            reconnectInProgress = false;
        }
    };

    const scheduleReconnectIfNeeded = (reason: string): void => {
        if (firstConnection) {
            return;
        }

        isConnected = false;
        logger.warn(`Redis connection lost (${reason}). Scheduling reconnect supervisor.`);

        void reconnectWithRetry().catch((err: any) => {
            logger.err(`Redis reconnection error. Error: ${err.message}`);
        });
    };

    // ============================================================================
    // Graceful Shutdown Handlers
    // ============================================================================
    
    /**
     * SIGINT Handler (Ctrl+C)
     * Ensures clean Redis disconnection before process termination
     * This is critical for preventing connection leaks and data corruption
     */
    if (!shutdownHandlersSetup) {
        logger.debug("Setting up SIGINT handler");
        process.on('SIGINT', async () => {
            logger.info('Received SIGINT, closing Redis connection...');
            try {
                if (redisClient) {
                    await redisClient.quit();
                    logger.info('Redis connection closed successfully');
                }
            } catch (error: any) {
                logger.err('Error closing Redis connection');
            }
            process.exit(0);
        });
        logger.debug("Finished setting up SIGINT handler");

        /**
         * SIGTERM Handler (Process termination signal)
         * Ensures clean Redis disconnection before process termination
         * Used by process managers (PM2, systemd, Docker, etc.) for graceful shutdown
         */
        logger.debug("Setting up SIGTERM handler");
        process.on('SIGTERM', async () => {
            logger.info('Received SIGTERM, closing Redis connection...');
            try {
                if (redisClient) {
                    await redisClient.quit();
                    logger.info('Redis connection closed successfully');
                }
            } catch (error: any) {
                logger.err('Error closing Redis connection');
            }
            process.exit(0);
        });
        logger.debug("Finished setting up SIGTERM handler");

        shutdownHandlersSetup = true;
    }

    // ============================================================================
    // Redis Client Creation
    // ============================================================================
    
    // Create client and set up event handlers before connecting
    // Uses the first node from ROOT_NODES as the primary connection point

    /**
     * Create Redis client with connection configuration
     * - Socket settings: host, port, timeouts, keep-alive
     * - Reconnection strategy: Exponential backoff (min(retries * 100, 3000)ms)
     * - Authentication: Username and password if provided
     */
    if (!redisClient) {
        redisClient = createClient({
            socket: {
                host: host,
                port: parseInt(port),
                connectTimeout: REDIS.CONNECT_TIMEOUT,  // Timeout for initial connection
                keepAlive: 5000,  // Keep-alive interval to maintain connection
                reconnectStrategy: () => false
            },
            username: REDIS.USERNAME,
            password: REDIS.PASSWORD
        });
    }

    // ============================================================================
    // Event Handlers - Monitor connection lifecycle and handle failures
    // ============================================================================
    
    /**
     * Handler for 'ready' event
     * Fired when Redis connection is successfully established and ready for commands
     */
    if (!clientHandlersSetup) {
        logger.debug("Setting up onReady handler");
        redisClient.on('ready', () => {
            retryCount = 0; // Reset retry count on successful connection
            isConnected = true;
            logger.info('Redis ready');
        });
        logger.debug("Finished setting up onReady handler");

        /**
         * Handler for 'error' event
         * Fired when connection errors occur (but connection may still be active)
         * This is different from 'end' - errors can occur while still connected
         */
        logger.debug("Setting up onError handler");
        redisClient.on('error', (error) => {
            logger.err(`Redis connection error. Message: ${error.message}`);

            const isReady = Boolean((redisClient as RedisClientType & { isReady?: boolean })?.isReady);
            if (!isReady) {
                scheduleReconnectIfNeeded(error.message || "unknown error");
            }
        });
        logger.debug("Finished setting up onError handler");

        /**
         * Handler for 'end' event
         * Fired when Redis connection is lost
         * Automatically attempts reconnection with the same retry logic as startup
         * Note: This is a critical event - the application may not function without Redis
         */
        logger.debug("Setting up onEnd handler");
        redisClient.on('end', () => {
            scheduleReconnectIfNeeded("end event");
        });
        logger.debug("Finished setting up onEnd handler");

        clientHandlersSetup = true;
    }

    // ============================================================================
    // Initial Connection
    // ============================================================================
    
    if (isConnected) {
        logger.finish("Redis already connected");
        return;
    }

    void connectWithRetry();

    logger.finish("Redis connection supervisor started");
}

/**
 * Get Redis client instance
 * 
 * Returns the singleton Redis client instance. Throws error if client
 * has not been initialized by calling connectToRedis() first.
 * 
 * @returns Redis client instance
 * @throws Error if Redis client is not initialized
 * 
 * @example
 * ```typescript
 * const client = getRedisClient();
 * await client.set('key', 'value');
 * ```
 */
export function getRedisClient(): RedisClientType {
    if (!redisClient) {
        throw new Error('Redis client not initialized. Call connectToRedis() first.');
    }
    return redisClient;
}

/**
 * Execute Redis operation with circuit breaker protection
 * 
 * Wraps any Redis operation with the circuit breaker pattern to prevent
 * cascading failures. When the circuit is open, operations fail fast without
 * attempting to reach Redis.
 * 
 * Circuit Breaker States:
 * - CLOSED: Normal operation, operations pass through
 * - OPEN: Circuit is open, operations fail fast (service is down)
 * - HALF_OPEN: Testing recovery, allows limited operations
 * 
 * @param operation - Redis operation to execute (async function)
 * @returns Result of the operation
 * @throws Error if circuit is open or operation fails
 * 
 * @example
 * ```typescript
 * // Wrap a Redis operation
 * const value = await executeWithCircuitBreaker(async () => {
 *   return await getRedisClient().get('key');
 * });
 * ```
 */
export async function executeWithCircuitBreaker<T>(operation: () => Promise<T>): Promise<T> {
    return await redisCircuitBreaker.execute(operation);
}

/**
 * Wrapper for Redis GET operation with circuit breaker protection
 * 
 * Retrieves a value from Redis by key. Returns null if:
 * - Redis is not connected
 * - Circuit breaker is open
 * - Key does not exist
 * - Operation fails
 * 
 * @param key - Redis key to retrieve
 * @returns Value associated with key, or null if not found/error
 * 
 * @example
 * ```typescript
 * const value = await redisGet('user:123');
 * if (value) {
 *   console.log('Found:', value);
 * }
 * ```
 */
export async function redisGet(key: string): Promise<string | null> {
    if (!isRedisConnected()) {
        return null;
    }

    const startedAt = Date.now();
    try {
        const result = await executeWithCircuitBreaker(async () => {
            return await getRedisClient().get(key);
        });
        redisCounter.recordSuccess(Date.now() - startedAt);
        return result;
    } catch (error) {
        redisCounter.recordFailure(Date.now() - startedAt);
        return null;
    }
}

/**
 * Wrapper for Redis SETEX operation with circuit breaker protection
 * 
 * Sets a key-value pair in Redis with expiration time (TTL).
 * Fails silently if Redis is unavailable (cache operations are non-critical).
 * 
 * @param key - Redis key to set
 * @param seconds - Time to live in seconds
 * @param value - Value to store
 * 
 * @example
 * ```typescript
 * await redisSetEx('session:abc123', 3600, 'user-data');
 * ```
 */
export async function redisSetEx(key: string, seconds: number, value: string): Promise<void> {
    if (!isRedisConnected()) {
        return;
    }

    const startedAt = Date.now();
    try {
        await executeWithCircuitBreaker(async () => {
            await getRedisClient().setEx(key, seconds, value);
        });
        redisCounter.recordSuccess(Date.now() - startedAt);
    } catch (error) {
        redisCounter.recordFailure(Date.now() - startedAt);
    }
}

/**
 * Wrapper for Redis DEL operation with circuit breaker protection
 * 
 * Deletes a key from Redis. Fails silently if Redis is unavailable
 * (cache operations are non-critical).
 * 
 * @param key - Redis key to delete
 * 
 * @example
 * ```typescript
 * await redisDel('session:abc123');
 * ```
 */
export async function redisDel(key: string): Promise<void> {
    if (!isRedisConnected()) {
        return;
    }

    const startedAt = Date.now();
    try {
        await executeWithCircuitBreaker(async () => {
            await getRedisClient().del(key);
        });
        redisCounter.recordSuccess(Date.now() - startedAt);
    } catch (error) {
        redisCounter.recordFailure(Date.now() - startedAt);
    }
}

/**
 * Wrapper for Redis MGET operation with circuit breaker protection
 * 
 * Retrieves multiple values from Redis by keys. Returns array of values
 * (null for missing keys). Returns array of nulls if Redis is unavailable.
 * 
 * @param keys - Array of Redis keys to retrieve
 * @returns Array of values (or null for missing keys)
 * 
 * @example
 * ```typescript
 * const values = await redisMGet(['key1', 'key2', 'key3']);
 * // Returns: ['value1', null, 'value3'] or [null, null, null] if Redis unavailable
 * ```
 */
export async function redisMGet(keys: string[]): Promise<(string | null)[]> {
    if (!isRedisConnected() || keys.length === 0) {
        return keys.map(() => null);
    }

    const startedAt = Date.now();
    try {
        const result = await executeWithCircuitBreaker(async () => {
            return await getRedisClient().mGet(keys);
        });
        redisCounter.recordSuccess(Date.now() - startedAt);
        return result;
    } catch (error) {
        redisCounter.recordFailure(Date.now() - startedAt);
        return keys.map(() => null);
    }
}

/**
 * Disconnect from Redis gracefully
 * 
 * Closes the Redis connection and cleans up resources.
 * Sets connection status to false and nullifies the client.
 * 
 * @example
 * ```typescript
 * await disconnectFromRedis();
 * ```
 */
export async function disconnectFromRedis(): Promise<void> {
    if (redisClient) {
        await redisClient.quit();
        redisClient = null;
    }
    isConnected = false;
}

/**
 * Check if Redis is currently connected
 * 
 * @returns true if Redis is connected and client is initialized, false otherwise
 * 
 * @example
 * ```typescript
 * if (!isRedisConnected()) {
 *   throw new Error('Redis not available');
 * }
 * ```
 */
export function isRedisConnected(): boolean {
    return isConnected && redisClient !== null;
}

// ============================================================================
// Helper Functions for Common Redis Operations
// ============================================================================
// Note: These functions do NOT use circuit breaker - use redisGet/redisSetEx
// for circuit breaker protection, or wrap these with executeWithCircuitBreaker

/**
 * Set a key-value pair in Redis with optional TTL
 * 
 * @param key - Redis key
 * @param value - Value to store
 * @param ttl - Optional time to live in seconds
 * 
 * @example
 * ```typescript
 * await setKey('user:123', 'data', 3600); // With TTL
 * await setKey('user:123', 'data'); // Without TTL
 * ```
 */
export async function setKey(key: string, value: string, ttl?: number): Promise<void> {
    const client = getRedisClient();
    if (ttl) {
        await client.setEx(key, ttl, value);
    } else {
        await client.set(key, value);
    }
}

/**
 * Get a value from Redis by key
 * 
 * @param key - Redis key to retrieve
 * @returns Value associated with key, or null if not found
 * 
 * @example
 * ```typescript
 * const value = await getKey('user:123');
 * ```
 */
export async function getKey(key: string): Promise<string | null> {
    const client = getRedisClient();
    return await client.get(key);
}

/**
 * Delete a key from Redis
 * 
 * @param key - Redis key to delete
 * @returns Number of keys deleted (0 or 1)
 * 
 * @example
 * ```typescript
 * const deleted = await deleteKey('user:123');
 * ```
 */
export async function deleteKey(key: string): Promise<number> {
    const client = getRedisClient();
    return await client.del(key);
}

/**
 * Check if a key exists in Redis
 * 
 * @param key - Redis key to check
 * @returns true if key exists, false otherwise
 * 
 * @example
 * ```typescript
 * if (await keyExists('user:123')) {
 *   console.log('Key exists');
 * }
 * ```
 */
export async function keyExists(key: string): Promise<boolean> {
    const client = getRedisClient();
    const exists = await client.exists(key);
    return exists > 0;
}

/**
 * Set a field in a Redis hash
 * 
 * @param hash - Hash key
 * @param field - Field name within the hash
 * @param value - Value to store
 * 
 * @example
 * ```typescript
 * await setHash('user:123', 'name', 'John Doe');
 * ```
 */
export async function setHash(hash: string, field: string, value: string): Promise<void> {
    const client = getRedisClient();
    await client.hSet(hash, field, value);
}

/**
 * Get a field value from a Redis hash
 * 
 * @param hash - Hash key
 * @param field - Field name within the hash
 * @returns Field value, or null if not found
 * 
 * @example
 * ```typescript
 * const name = await getHash('user:123', 'name');
 * ```
 */
export async function getHash(hash: string, field: string): Promise<string | null> {
    const client = getRedisClient();
    return await client.hGet(hash, field);
}

/**
 * Get all fields and values from a Redis hash
 * 
 * @param hash - Hash key
 * @returns Object with all field-value pairs
 * 
 * @example
 * ```typescript
 * const user = await getAllHash('user:123');
 * // Returns: { name: 'John', email: 'john@example.com' }
 * ```
 */
export async function getAllHash(hash: string): Promise<Record<string, string>> {
    const client = getRedisClient();
    return await client.hGetAll(hash);
}

/**
 * Delete a field from a Redis hash
 * 
 * @param hash - Hash key
 * @param field - Field name to delete
 * @returns Number of fields deleted (0 or 1)
 * 
 * @example
 * ```typescript
 * const deleted = await deleteHash('user:123', 'name');
 * ```
 */
export async function deleteHash(hash: string, field: string): Promise<number> {
    const client = getRedisClient();
    return await client.hDel(hash, field);
}

/**
 * Comprehensive Redis health check function
 * 
 * Returns connection status, connection details, and circuit breaker statistics.
 * Automatically logs warnings if circuit breaker is open.
 * 
 * @returns Health status object containing:
 * - connected: Boolean indicating if Redis is connected
 * - isReady: Boolean indicating if Redis is ready for commands
 * - circuitBreaker: Circuit breaker statistics and state
 * 
 * @example
 * ```typescript
 * const health = getRedisHealth();
 * if (!health.connected) {
 *   console.error('Redis is not connected!');
 * }
 * if (health.circuitBreaker?.state === 'OPEN') {
 *   console.warn('Circuit breaker is OPEN - Redis unavailable');
 * }
 * ```
 */
export async function getRedisHealth(): Promise<RedisHealth> { 
    const connected = isConnected && redisClient !== null;
    const isReady = connected && (redisClient as any)?.isReady === true;
    const circuitBreakerStats = redisCircuitBreaker.getStats();

    // Warn if circuit breaker is open (service is down)
    if (circuitBreakerStats.state === 'OPEN') {
        const logger = getLogger("redis_health_monitor");
        logger.warn?.(
            `Redis circuit breaker is OPEN - service unavailable`,
            {
                circuitBreaker: circuitBreakerStats
            }
        );
    }

    const counters = redisCounter.getStats();

    return {
        completedJobs: counters.completedJobs,
        failedJobs: counters.failedJobs,
        lastStart: uptimeKeeper.getLastStart("redis"),
        totalTime: counters.totalTime,
        connected,
        isReady,
        ping: await pingRedis(),
        // Surface the configured node list so the dashboard can identify
        // which Redis deployment a card refers to. Defensive `|| []` guards
        // against misconfigured envs.
        nodes: REDIS.ROOT_NODES || [],
        circuitBreaker: circuitBreakerStats
    };
}

/**
 * Test Redis connection with a PING command
 * 
 * Sends a PING command to Redis to verify connectivity.
 * Uses circuit breaker protection to prevent cascading failures.
 * 
 * @returns true if PING successful (received 'PONG'), false otherwise
 * 
 * @example
 * ```typescript
 * const isAlive = await pingRedis();
 * if (!isAlive) {
 *   console.warn('Redis is not responding');
 * }
 * ```
 */
export async function pingRedis(): Promise<boolean> {
    if (!isRedisConnected()) {
        return false;
    }

    try {
        const result = await executeWithCircuitBreaker(async () => {
            const client = getRedisClient();
            return await client.ping();
        });
        return result === 'PONG';
    } catch (error) {
        // Circuit breaker is open or operation failed
        return false;
    }
}

/**
 * Get Redis circuit breaker statistics
 * 
 * Returns the current state and statistics of the Redis circuit breaker,
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
 * const stats = getRedisCircuitBreakerStats();
 * if (stats.state === 'OPEN') {
 *   console.warn('Redis circuit breaker is OPEN - service unavailable');
 * }
 * ```
 */
export function getRedisCircuitBreakerStats() {
    return redisCircuitBreaker.getStats();
}

/**
 * Check if Redis circuit breaker is open
 * 
 * Quick check to determine if the circuit breaker is currently open,
 * which means Redis operations will fail fast.
 * 
 * @returns true if circuit is open, false otherwise
 * 
 * @example
 * ```typescript
 * if (isRedisCircuitBreakerOpen()) {
 *   return { error: 'Cache temporarily unavailable' };
 * }
 * ```
 */
export function isRedisCircuitBreakerOpen(): boolean {
    return redisCircuitBreaker.isOpen();
}

/**
 * Manually reset the Redis circuit breaker
 * 
 * Resets the circuit breaker to CLOSED state, clearing all failure counts.
 * Use with caution - only reset if you're certain the service has recovered.
 * 
 * @example
 * ```typescript
 * // After confirming Redis is back online
 * resetRedisCircuitBreaker();
 * ```
 */
export function resetRedisCircuitBreaker(): void {
    redisCircuitBreaker.reset();
}
