/**
 * Telegram Bot Connection Manager
 * 
 * Provides comprehensive Telegram bot integration with:
 * - Telegraf bot instance management
 * - Circuit breaker pattern for failure protection and cascading failure prevention
 * - Command handlers for bot interactions (/start, /help, /hi)
 * - User account linking via verification codes
 * - Message handling for non-bot users
 * - Graceful shutdown handling (SIGINT, SIGTERM)
 * - Health monitoring and connection status checks
 * 
 * Bot Configuration:
 * - NAME: Telegram bot username
 * - TOKEN: Telegram bot API token for authentication
 * 
 * Bot Commands:
 * - /start {code}: Links user account to Telegram using verification code
 *   - Verifies code from user.requests.telegram.code
 *   - Stores chatId in user.telegram.chatId
 *   - Sends confirmation message to user
 * - /help: Displays help message
 * - /hi: Greets the user with their name
 * 
 * Message Handling:
 * - Responds to all messages from non-bot users
 * - Provides friendly greeting responses
 * 
 * Account Linking Flow:
 * 1. User generates QR code via POST /api/user/telegram
 * 2. System stores verification code in user.requests.telegram.code
 * 3. User scans QR code and starts bot with /start {code}
 * 4. Bot verifies code and links chatId to user account
 * 5. User receives confirmation message
 * 
 * Circuit Breaker:
 * - Protects Telegram bot operations from cascading failures
 * - Automatically opens after 5 failures within 60 seconds
 * - Resets after 30 seconds in HALF_OPEN state
 * - Requires 2 successful operations to close from HALF_OPEN
 * 
 * @module connectToTelegram
 */

import {Telegraf} from "telegraf";
import User from "@coreModule/database/schemas/user/user";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {CONSTANTS, TELEGRAM} from "@coreModule/environment";
import {message} from "telegraf/filters";
import {telegramCircuitBreaker} from "@coreModule/utilities/circuitBreaker";
import {TelegramHealth} from "armonia/src/modules/core/api/auxiliary/private/serverHealth/serverHealth.dto";
import {emitNotificationEvent, NotificationEventCodes} from "@coreModule/domain/notifications/notificationEventBus";
import {uptimeKeeper} from "@coreModule/utilities/uptime/uptimeKeeper";
import {redisDel, redisGet, redisSetEx} from "@coreModule/connections/connectToRedis";
import {
    TELEGRAM_HEALTH_SNAPSHOT_KEY,
    TELEGRAM_HEALTH_SNAPSHOT_TTL_SECONDS
} from "@coreModule/utilities/timing/healthSnapshot";

/**
 * Telegraf bot instance - singleton instance for Telegram bot operations
 * This instance is created once and reused throughout the application lifecycle
 */
export const telegrafBot = new Telegraf(TELEGRAM.TOKEN);

/** Connection status flag - tracks if Telegram bot is currently running */
let isConnected = false;

/** Flag to track if shutdown handlers have been set up (only set up once) */
let shutdownHandlersSetup = false;

/** Flag to ensure bot command/message handlers are only registered once */
let handlersSetup = false;

/** Prevent overlapping launch attempts */
let launchInProgress = false;

/** Refreshes Redis `health:telegram` while Telegraf runs in this process (API only). */
let telegramHealthSnapTimer: ReturnType<typeof setInterval> | null = null;

const TELEGRAM_RETRY_TIMER = 5000;

function flushTelegramHealthSnapshot(): void {
    if (!isConnected) {
        return;
    }
    void redisSetEx(
        TELEGRAM_HEALTH_SNAPSHOT_KEY,
        TELEGRAM_HEALTH_SNAPSHOT_TTL_SECONDS,
        JSON.stringify(getTelegramHealth())
    ).catch(() => {});
}

function startTelegramHealthSnapshotPublisher(): void {
    if (telegramHealthSnapTimer !== null) {
        return;
    }
    flushTelegramHealthSnapshot();
    telegramHealthSnapTimer = setInterval(flushTelegramHealthSnapshot, 10_000);
}

function stopTelegramHealthSnapshotPublisher(): void {
    if (telegramHealthSnapTimer !== null) {
        clearInterval(telegramHealthSnapTimer);
        telegramHealthSnapTimer = null;
    }
    void redisDel(TELEGRAM_HEALTH_SNAPSHOT_KEY).catch(() => {});
}

async function waitForRetry(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Establishes connection to Telegram bot with command and message handlers
 * 
 * This function:
 * 1. Sets up command handlers (/start, /help, /hi)
 * 2. Sets up message handlers for user interactions
 * 3. Launches the bot to start receiving updates
 * 4. Sets up graceful shutdown handlers
 * 
 * @param parentLogger - Parent logger instance for hierarchical logging
 * 
 * @example
 * ```typescript
 * // Basic connection
 * await connectToTelegramInstance(logger);
 * ```
 */
export async function connectToTelegramInstance(parentLogger: serverLogger): Promise<void>{

    let logger = getLogger("connecting_to_telegram_instance", parentLogger);
    logger.start("Setting up Telegram instance");
    logger.debug(`Telegram target bot=${TELEGRAM.NAME}, token=${TELEGRAM.TOKEN ? 'provided' : 'not provided'}`);

    if (isConnected) {
        logger.debug("Telegram instance already connected. Skipping launch.");
        logger.finish("Telegram already connected");
        return;
    }

    if (launchInProgress) {
        logger.debug("Telegram launch already in progress. Skipping duplicate launch.");
        logger.finish("Telegram connection supervisor already running");
        return;
    }
    
    const launchWithRetry = async (): Promise<void> => {
        if (launchInProgress) {
            logger.debug("Telegram launch already in progress. Skipping duplicate launch.");
            return;
        }

        launchInProgress = true;

        try {
            let currentRetryCount = 0;

            while (!isConnected) {
                try {
                    // Launch supervision must always keep trying while Telegram is down.
                    // The circuit breaker still protects bot operations separately.
                    //
                    // Telegraf: `launch()` awaits long polling until `stop()` — it does not resolve
                    // once polling starts. Run post-connect work in the hook (after getMe, before polling).
                    await telegrafBot.launch({}, () => {
                        void (async () => {
                            isConnected = true;
                            logger.info("Telegram connected");
                            await uptimeKeeper.markStart("telegram");
                            startTelegramHealthSnapshotPublisher();
                        })();
                    });
                    // Promise settles only after telegrafBot.stop() ends polling (shutdown / migration).
                } catch (e: any) {
                    currentRetryCount++;
                    isConnected = false;
                    logger.err(`Telegram connection failed: ${e.message}. Retrying in ${TELEGRAM_RETRY_TIMER} ms.`);
                    await waitForRetry(TELEGRAM_RETRY_TIMER);
                }
            }
        } finally {
            launchInProgress = false;
        }
    };
    
    try{
        if (!handlersSetup) {
            // ============================================================================
            // Command Handlers
            // ============================================================================
            
            /**
             * /start command handler
             * Links user account to Telegram using verification code
             * 
             * Flow:
             * 1. Extracts verification code from command payload
             * 2. Finds user with matching code in requests.telegram.code
             * 3. Stores chatId in user.telegram.chatId
             * 4. Sends confirmation message to user
             */
            telegrafBot.start(async (ctx) => {
                const startLogger = getLogger("telegram-start-command", logger);
                startLogger.debug(`Received /start command from chat ${ctx.chat.id}`);
                
                try {
                    // Wrap critical operations with circuit breaker protection
                    await telegramCircuitBreaker.execute(async () => {
                        let startPayload = ctx.payload; // Verification code from /start {code}
                        
                        // Find user with matching verification code
                        let user = await User.findOne({"requests.telegram.code": startPayload})
                            .select("userProfile username companies telegram requests.telegram");
                        
                        if( !!user ){

                            if( !user.telegram ){
                                user.telegram = {
                                    runProtocols: false,
                                    chatId: ctx.chat.id
                                }
                            }

                            // Link Telegram chatId to user account
                            user.telegram.chatId = ctx.chat.id;
                            await user.save();
                            
                            startLogger.info(`Telegram successfully linked for user: ${user.username}`);
                            await ctx.reply(`Telegram successfully activated for your account: ${user.username}`);

                            const companyRef = user.companies?.[0];
                            const notificationCompanyId = companyRef
                                ? String((companyRef as {_id?: unknown})._id ?? companyRef)
                                : undefined;
                            if (notificationCompanyId) {
                                emitNotificationEvent(NotificationEventCodes.TELEGRAM_LINKED, {
                                    receiverIds: [user._id.toString()],
                                    payload: {
                                        companyId: notificationCompanyId,
                                        languageCode: CONSTANTS.DEFAULT_LANGUAGE
                                    }
                                });
                            }
                        }
                        else{
                            // Invalid or expired verification code
                            startLogger.warn(`Invalid verification code from chat ${ctx.chat.id}`);
                            await ctx.reply(`Invalid verification code. Please generate a new QR code.`);
                        }
                    });
                } catch (error: any) {
                    const startLogger = getLogger("telegram-start-command", logger);
                    
                    // Check if error is from circuit breaker
                    if (error.message?.includes('Circuit breaker')) {
                        startLogger.warn(`Circuit breaker is OPEN - Telegram service unavailable`);
                        await ctx.reply(`Telegram service is temporarily unavailable. Please try again later.`);
                    } else {
                        startLogger.err(`Error processing /start command: ${error.message}`);
                        await ctx.reply(`An error occurred while linking your account. Please try again.`);
                    }
                }
            });

            /**
             * /help command handler
             * Provides help information to users
             */
            telegrafBot.help(async (ctx) => {
                try {
                    await telegramCircuitBreaker.execute(async () => {
                        await ctx.reply('Send me a sticker');
                    });
                } catch (error: any) {
                    const helpLogger = getLogger("telegram-help-command", logger);
                    if (error.message?.includes('Circuit breaker')) {
                        helpLogger.warn(`Circuit breaker is OPEN - Telegram service unavailable`);
                    } else {
                        helpLogger.err(`Error processing /help command: ${error.message}`);
                    }
                }
            });

            /**
             * /hi command handler
             * Greets the user with their name (only for non-bot users)
             */
            telegrafBot.command('hi', async (ctx) => {
                if( !ctx.from.is_bot ){
                    try {
                        await telegramCircuitBreaker.execute(async () => {
                            let {first_name, last_name} = ctx.from;
                            await ctx.reply(`Hey there ${first_name} ${last_name}!`);
                        });
                    } catch (error: any) {
                        const hiLogger = getLogger("telegram-hi-command", logger);
                        if (error.message?.includes('Circuit breaker')) {
                            hiLogger.warn(`Circuit breaker is OPEN - Telegram service unavailable`);
                        } else {
                            hiLogger.err(`Error processing /hi command: ${error.message}`);
                        }
                    }
                }
            });

            // ============================================================================
            // Message Handlers
            // ============================================================================
            
            /**
             * General message handler
             * Responds to all messages from non-bot users
             * Provides friendly greeting responses
             */
            telegrafBot.on(message(), async (ctx) => {
                if( !ctx.from.is_bot ){
                    try {
                        await telegramCircuitBreaker.execute(async () => {
                            let {first_name, last_name} = ctx.from;
                            await ctx.reply(`Hey there ${first_name} ${last_name}!`);
                        });
                    } catch (error: any) {
                        const messageLogger = getLogger("telegram-message-handler", logger);
                        if (error.message?.includes('Circuit breaker')) {
                            messageLogger.warn(`Circuit breaker is OPEN - Telegram service unavailable`);
                        } else {
                            messageLogger.err(`Error processing message: ${error.message}`);
                        }
                    }
                }
            });

            handlersSetup = true;
        }

        // ============================================================================
        // Graceful Shutdown Handlers
        // ============================================================================
        // Set up shutdown handlers only once (on first connection)
        // These handlers will persist for the lifetime of the process
        
        if (!shutdownHandlersSetup) {
            /**
             * SIGINT Handler (Ctrl+C)
             * Ensures clean Telegram bot shutdown before process termination
             * This is critical for preventing connection leaks and ensuring proper cleanup
             */
            logger.debug("Setting up SIGINT handler");
            process.on('SIGINT', async () => {
                const shutdownLogger = getLogger("telegram-shutdown");
                shutdownLogger.info('Received SIGINT, stopping Telegram bot...');
                try {
                    if (telegrafBot) {
                        await telegrafBot.stop('SIGINT');
                        isConnected = false;
                        stopTelegramHealthSnapshotPublisher();
                        shutdownLogger.info('Telegram bot stopped successfully');
                    }
                } catch (error) {
                    shutdownLogger.err('Error stopping Telegram bot');
                }
                process.exit(0);
            });
            logger.debug("Finished setting up SIGINT handler");

            /**
             * SIGTERM Handler (Process termination signal)
             * Ensures clean Telegram bot shutdown before process termination
             * Used by process managers (PM2, systemd, Docker, etc.) for graceful shutdown
             */
            logger.debug("Setting up SIGTERM handler");
            process.on('SIGTERM', async () => {
                const shutdownLogger = getLogger("telegram-shutdown");
                shutdownLogger.info('Received SIGTERM, stopping Telegram bot...');
                try {
                    if (telegrafBot) {
                        await telegrafBot.stop('SIGTERM');
                        isConnected = false;
                        stopTelegramHealthSnapshotPublisher();
                        shutdownLogger.info('Telegram bot stopped successfully');
                    }
                } catch (error) {
                    shutdownLogger.err('Error stopping Telegram bot');
                }
                process.exit(0);
            });
            logger.debug("Finished setting up SIGTERM handler");
            
            shutdownHandlersSetup = true;
        }

    }
    catch (e: any){
        logger.err(`Telegram initialization failed: ${e.message}`);
        logger.fail("Failed to initialize Telegram instance");
        return;
    }

    void launchWithRetry().catch((e: any) => {
        logger.err(`Telegram connection supervisor failed: ${e.message}`);
    });

    logger.finish("Telegram connection supervisor started");
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Disconnect from Telegram bot gracefully
 * 
 * Stops the Telegram bot and cleans up resources.
 * Resets connection status.
 * 
 * @example
 * ```typescript
 * await disconnectFromTelegram();
 * ```
 */
export async function disconnectFromTelegram(): Promise<void> {
    if (telegrafBot) {
        try {
            await telegrafBot.stop();
            isConnected = false;
            stopTelegramHealthSnapshotPublisher();
        } catch (error) {
            const logger = getLogger("telegram-disconnect");
            logger.err('Error disconnecting from Telegram bot');
        }
    }
}

/**
 * Check if Telegram bot is currently connected and running
 * 
 * @returns true if Telegram bot is connected and running, false otherwise
 * 
 * @example
 * ```typescript
 * if (!isTelegramConnected()) {
 *   throw new Error('Telegram bot not available');
 * }
 * ```
 */
export function isTelegramConnected(): boolean {
    return isConnected;
}

/**
 * Comprehensive Telegram bot health check function
 * 
 * Returns connection status, bot information, and circuit breaker statistics.
 * Automatically logs warnings if circuit breaker is open.
 * 
 * @returns Health status object containing:
 * - connected: Boolean indicating if Telegram bot is running
 * - botName: Telegram bot username
 * - circuitBreaker: Circuit breaker statistics and state
 * 
 * @example
 * ```typescript
 * const health = getTelegramHealth();
 * if (!health.connected) {
 *   console.error('Telegram bot is not running!');
 * }
 * if (health.circuitBreaker?.state === 'OPEN') {
 *   console.warn('Circuit breaker is OPEN - Telegram unavailable');
 * }
 * ```
 */
export function getTelegramHealth(): TelegramHealth {
    const circuitBreakerStats = telegramCircuitBreaker.getStats();

    // Warn if circuit breaker is open (service is down)
    if (circuitBreakerStats.state === 'OPEN') {
        const healthLogger = getLogger("telegram_health_monitor");
        healthLogger.warn?.(
            `Telegram circuit breaker is OPEN - service unavailable`,
            {
                circuitBreaker: circuitBreakerStats
            }
        );
    }

    return {
        lastStart: uptimeKeeper.getLastStart("telegram"),
        connected: isConnected, 
        botName: TELEGRAM.NAME,
        messages: 0,
        users: 0,
        circuitBreaker: circuitBreakerStats
    };
}

/**
 * Telegram health for dashboards that run outside the Telegraf process (e.g. WebSocket server).
 * Reads Redis snapshot written by the API when the bot is connected; falls back to {@link getTelegramHealth}.
 */
export async function getTelegramHealthResolved(): Promise<TelegramHealth> {
    const local = getTelegramHealth();
    const raw = await redisGet(TELEGRAM_HEALTH_SNAPSHOT_KEY);
    if (!raw) {
        return local;
    }
    try {
        const parsed = JSON.parse(raw) as Partial<TelegramHealth>;
        if (typeof parsed.connected !== "boolean") {
            return local;
        }
        // Merge so a partial JSON blob (or strict-validation rejects) still upgrades `connected` from Redis.
        return {
            lastStart: typeof parsed.lastStart === "number" ? parsed.lastStart : local.lastStart,
            connected: parsed.connected,
            botName: typeof parsed.botName === "string" ? parsed.botName : local.botName,
            messages: typeof parsed.messages === "number" ? parsed.messages : local.messages,
            users: typeof parsed.users === "number" ? parsed.users : local.users,
            circuitBreaker: parsed.circuitBreaker ?? local.circuitBreaker
        };
    } catch {
        return local;
    }
}

/**
 * Get Telegram bot instance
 * 
 * Returns the singleton Telegraf bot instance.
 * 
 * @returns Telegraf bot instance
 * 
 * @example
 * ```typescript
 * const bot = getTelegramBot();
 * await bot.telegram.sendMessage(chatId, 'Hello!');
 * ```
 */
export function getTelegramBot(): Telegraf {
    return telegrafBot;
}

/**
 * Execute Telegram operation with circuit breaker protection
 * 
 * Wraps any Telegram bot operation with the circuit breaker pattern to prevent
 * cascading failures. When the circuit is open, operations fail fast without
 * attempting to reach Telegram API.
 * 
 * Circuit Breaker States:
 * - CLOSED: Normal operation, operations pass through
 * - OPEN: Circuit is open, operations fail fast (service is down)
 * - HALF_OPEN: Testing recovery, allows limited operations
 * 
 * @param operation - Telegram operation to execute (async function)
 * @returns Result of the operation
 * @throws Error if circuit is open or operation fails
 * 
 * @example
 * ```typescript
 * // Wrap a Telegram send message operation
 * await executeWithCircuitBreaker(async () => {
 *   await telegrafBot.telegram.sendMessage(chatId, 'Hello!');
 * });
 * ```
 */
export async function executeWithCircuitBreaker<T>(operation: () => Promise<T>): Promise<T> {
    return await telegramCircuitBreaker.execute(operation);
}

/**
 * Get Telegram circuit breaker statistics
 * 
 * Returns the current state and statistics of the Telegram circuit breaker,
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
 * const stats = getTelegramCircuitBreakerStats();
 * if (stats.state === 'OPEN') {
 *   console.warn('Telegram circuit breaker is OPEN - service unavailable');
 * }
 * ```
 */
export function getTelegramCircuitBreakerStats() {
    return telegramCircuitBreaker.getStats();
}

/**
 * Check if Telegram circuit breaker is open
 * 
 * Quick check to determine if the circuit breaker is currently open,
 * which means Telegram operations will fail fast.
 * 
 * @returns true if circuit is open, false otherwise
 * 
 * @example
 * ```typescript
 * if (isTelegramCircuitBreakerOpen()) {
 *   return { error: 'Telegram temporarily unavailable' };
 * }
 * ```
 */
export function isTelegramCircuitBreakerOpen(): boolean {
    return telegramCircuitBreaker.isOpen();
}

/**
 * Manually reset the Telegram circuit breaker
 * 
 * Resets the circuit breaker to CLOSED state, clearing all failure counts.
 * Use with caution - only reset if you're certain the service has recovered.
 * 
 * @example
 * ```typescript
 * // After confirming Telegram API is back online
 * resetTelegramCircuitBreaker();
 * ```
 */
export function resetTelegramCircuitBreaker(): void {
    telegramCircuitBreaker.reset();
}