/**
 * Telegram Bot Connection Manager
 * 
 * Telegram is a ONE-WAY NOTIFICATION transport only. It delivers outbound
 * notifications and supports account linking (/start); it does NOT route inbound
 * user messages into the AI-assistant. The AI-assistant is decoupled from Telegram
 * and is reachable ONLY through the in-app internal chat (see aiAssistantResponder.ts).
 *
 * Long-polling (getUpdates) runs in telegramServer. Other processes (e.g. apiServer)
 * may use the Telegraf client for outbound sendMessage without calling launch().
 *
 * Provides:
 * - Telegraf bot instance management
 * - Circuit breaker pattern for failure protection and cascading failure prevention
 * - Command handlers for account linking (/start) and trivial static replies (/help, /hi)
 * - User account linking via single-use verification codes
 * - Health monitoring and connection status checks
 *
 * Bot Configuration:
 * - NAME: Telegram bot username
 * - TOKEN: Telegram bot API token for authentication
 *
 * Bot Commands:
 * - /start {code}: Links user account to Telegram using verification code
 *   - Verifies code from user.requests.telegram.code, then clears it (single use)
 *   - Stores chatId in user.telegram.chatId
 *   - Sends confirmation message to user
 * - /help: Static reply (no AI)
 * - /hi: Greets the user with their name (static, no AI)
 *
 * NOTE: There is deliberately no general free-text message handler. Inbound
 * Telegram messages are ignored; the AI-assistant is NOT reachable via Telegram.
 *
 * Account Linking Flow:
 * 1. User generates QR code via POST /api/user/telegram
 * 2. System stores verification code in user.requests.telegram.code
 * 3. User scans QR code and starts bot with /start {code}
 * 4. Bot verifies code, links chatId to user account and clears the code
 * 5. User receives confirmation message
 * 
 * Circuit Breaker:
 * - Wraps calls to the Telegram API only (sends and replies), never database work
 * - Opens after 5 failures within 60 seconds; a call slower than 15 seconds counts as a failure
 * - Lets a trial call through after 30 seconds (HALF_OPEN)
 * - Requires 2 successful operations to close from HALF_OPEN
 * 
 * @module connectToTelegram
 */

import {randomUUID} from "crypto";
import os from "os";
import {Context, Telegraf} from "telegraf";
import User from "@coreModule/database/schemas/user/user";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {CONSTANTS, TELEGRAM} from "@coreModule/environment";
import {telegramCircuitBreaker} from "@coreModule/utilities/circuitBreaker";
import {TelegramHealth} from "armonia/src/modules/core/api/auxiliary/private/serverHealth/serverHealth.dto";
import {emitNotificationEvent, NotificationEventCodes} from "@coreModule/domain/notifications/notificationEventBus";
import {uptimeKeeper} from "@coreModule/utilities/uptime/uptimeKeeper";
import {
    redisDel,
    redisGet,
    redisReleaseLock,
    redisSetEx,
    redisTryAcquireOrRenewLock
} from "@coreModule/connections/connectToRedis";
import {
    TELEGRAM_HEALTH_SNAPSHOT_KEY,
    TELEGRAM_HEALTH_SNAPSHOT_TTL_SECONDS
} from "@coreModule/utilities/timing/healthSnapshot";
import {telegramCounter} from "@coreModule/utilities/serviceMetrics/serviceCounters";

/**
 * Telegraf bot instance - singleton instance for Telegram bot operations
 * This instance is created once and reused throughout the application lifecycle
 */
const telegrafBot = new Telegraf(TELEGRAM.TOKEN);

/** Connection status flag - tracks if Telegram bot is currently running */
let isConnected = false;

/** Flag to ensure bot command/message handlers are only registered once */
let handlersSetup = false;

/** Prevent overlapping launch attempts */
let launchInProgress = false;

/** Refreshes Redis `health:telegram` while Telegraf runs in this process (telegramServer). */
let telegramHealthSnapTimer: ReturnType<typeof setInterval> | null = null;

// ============================================================================
// Single-poller leadership lock
// ============================================================================
// Telegram permits only ONE active getUpdates long-poll per bot token; a second
// poller triggers `409 Conflict: terminated by other getUpdates request`. Across
// replicas/cluster nodes every process would otherwise start its own poll. So the
// long-poll is guarded by a Redis leadership lock: exactly one process holds it
// and polls; the rest stand by and take over only when the holder's lock expires
// (crash) or is released (graceful shutdown).

/** Redis key holding the single-poller leadership lock (one holder cluster-wide). */
const TELEGRAM_POLLER_LOCK_KEY = "telegram:poller:leader";

/** Lock TTL. Must exceed the renew interval so a healthy leader never self-expires. */
const TELEGRAM_POLLER_LOCK_TTL_SECONDS = 30;

/** How often the leader renews its lock (comfortably under the TTL). */
const TELEGRAM_POLLER_LOCK_RENEW_MS = 10_000;

/** How often a follower re-checks whether leadership has freed up. */
const TELEGRAM_POLLER_FOLLOWER_POLL_MS = 10_000;

/** Unique owner id for this process, so only we can renew/release our own lock. */
const TELEGRAM_POLLER_INSTANCE_ID = `${global.ServerName ?? "server"}:${process.pid}:${randomUUID()}`;

/** True while this process holds the poller lock (i.e. it runs the long-poll). */
let isLeader = false;

/** Prevent overlapping leadership supervisors in one process. */
let leadershipInProgress = false;

/** Set by {@link disconnectFromTelegram} to permanently stop this process polling. */
let pollerDisabled = false;

/**
 * Release the poller lock if we hold it, so another instance can take over
 * immediately instead of waiting for the TTL to lapse.
 */
async function releasePollerLeadership(): Promise<void> {
    if (!isLeader) {
        return;
    }
    isLeader = false;
    await redisReleaseLock(TELEGRAM_POLLER_LOCK_KEY, TELEGRAM_POLLER_INSTANCE_ID);
}

function flushTelegramHealthSnapshot(): void {
    if (!isConnected) {
        return;
    }
    void (async () => {
        // Pull cross-process send counters (apiServer) before snapshotting.
        await telegramCounter.hydrate().catch(() => {});
        await redisSetEx(
            TELEGRAM_HEALTH_SNAPSHOT_KEY,
            TELEGRAM_HEALTH_SNAPSHOT_TTL_SECONDS,
            JSON.stringify(getTelegramHealth())
        );
    })().catch(() => {});
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
 * 1. Sets up command handlers (/start, /help, /hi) — no free-text/AI handler
 * 2. Starts the leadership supervisor, which launches polling in the one
 *    process holding the Redis poller lock
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

    if (leadershipInProgress) {
        logger.debug("Telegram leadership supervisor already running. Skipping duplicate.");
        logger.finish("Telegram connection supervisor already running");
        return;
    }

    // A single Telegraf launch attempt. `launch()` awaits long polling until
    // `stop()` — it does not resolve once polling starts. Post-connect work runs
    // in the hook (after getMe, before polling). Resolves on stop()/standdown;
    // throws if the launch itself fails.
    const launchBot = async (): Promise<void> => {
        await telegrafBot.launch({}, () => {
            void (async () => {
                isConnected = true;
                logger.info("Telegram connected");
                await uptimeKeeper.markStart("telegram");
                startTelegramHealthSnapshotPublisher();
            })();
        });
    };

    // Stop polling in this process (leadership standdown / disable). Best-effort.
    const standDownFromPolling = async (): Promise<void> => {
        if (!isConnected && !launchInProgress) {
            return;
        }
        try {
            await telegrafBot.stop();
        } catch (e: any) {
            logger.err(`Error stopping Telegram polling on standdown: ${e?.message ?? e}`);
        }
        isConnected = false;
        stopTelegramHealthSnapshotPublisher();
    };

    // Leadership supervisor: only the process that holds the Redis poller lock
    // runs the long-poll, so 409 "terminated by other getUpdates" is impossible
    // across replicas/cluster nodes. Followers stand by and take over only when
    // the leader's lock expires (crash) or is released (graceful stop).
    const runLeadershipSupervisor = async (): Promise<void> => {
        if (leadershipInProgress) {
            logger.debug("Telegram leadership supervisor already running. Skipping duplicate.");
            return;
        }
        leadershipInProgress = true;

        try {
            // Runs for the lifetime of the process.
            // eslint-disable-next-line no-constant-condition
            while (true) {
                // Permanently disabled via disconnectFromTelegram(): stand down and idle.
                if (pollerDisabled) {
                    if (isConnected || isLeader) {
                        await standDownFromPolling();
                        await releasePollerLeadership();
                    }
                    await waitForRetry(TELEGRAM_POLLER_FOLLOWER_POLL_MS);
                    continue;
                }

                let holdsLock = false;
                try {
                    holdsLock = await redisTryAcquireOrRenewLock(
                        TELEGRAM_POLLER_LOCK_KEY,
                        TELEGRAM_POLLER_INSTANCE_ID,
                        TELEGRAM_POLLER_LOCK_TTL_SECONDS
                    );
                } catch (e: any) {
                    // On any lock error, behave as a follower this tick (fail safe).
                    logger.err(`Telegram leadership lock check failed: ${e?.message ?? e}`);
                    holdsLock = false;
                }

                if (holdsLock && !isLeader) {
                    isLeader = true;
                    logger.info(`Acquired Telegram poller leadership (owner=${TELEGRAM_POLLER_INSTANCE_ID})`);
                } else if (!holdsLock && isLeader) {
                    // Another instance now owns the lock (e.g. we stalled past the TTL).
                    // Stop polling immediately so it is the only poller.
                    logger.warn("Lost Telegram poller leadership; standing down (another instance is the poller).");
                    isLeader = false;
                    await standDownFromPolling();
                }

                // As leader, ensure the long-poll is running. launchBot() blocks
                // until stop()/standdown; we keep looping to renew the lock while
                // it polls, so `launchInProgress` stays true for the poll's lifetime.
                if (isLeader && !isConnected && !launchInProgress) {
                    launchInProgress = true;
                    void launchBot()
                        .catch((e: any) => {
                            logger.err(`Telegram launch failed: ${e?.message ?? e}. Will retry while leader.`);
                        })
                        .finally(() => {
                            isConnected = false;
                            launchInProgress = false;
                        });
                }

                // Leaders renew often; followers just poll for a free lock.
                await waitForRetry(isLeader ? TELEGRAM_POLLER_LOCK_RENEW_MS : TELEGRAM_POLLER_FOLLOWER_POLL_MS);
            }
        } finally {
            leadershipInProgress = false;
        }
    };

    try{
        if (!handlersSetup) {
            // ============================================================================
            // Command Handlers
            // ============================================================================
            
            /** Replies through the Telegram circuit breaker; a failed reply is logged, never thrown. */
            const safeReply = async (ctx: Context, text: string, handlerLogger: serverLogger): Promise<void> => {
                try {
                    await telegramCircuitBreaker.execute(() => ctx.reply(text));
                } catch (error: any) {
                    handlerLogger.warn(`Telegram reply failed: ${error?.message ?? error}`);
                }
            };

            /**
             * /start command handler
             * Links user account to Telegram using verification code
             * 
             * Flow:
             * 1. Extracts verification code from command payload
             * 2. Finds user with matching code in requests.telegram.code
             * 3. Stores chatId in user.telegram.chatId and clears the code (single use)
             * 4. Sends confirmation message to user
             */
            telegrafBot.start(async (ctx) => {
                const startLogger = getLogger("telegram-start-command", logger);
                startLogger.debug(`Received /start command from chat ${ctx.chat.id}`);

                const startPayload = ctx.payload; // Verification code from /start {code}
                if (!startPayload) {
                    await safeReply(ctx, `To link your account, scan the Telegram QR code from your profile settings.`, startLogger);
                    return;
                }

                let linkedUsername: string | null = null;
                try {
                    // Find user with matching verification code
                    const user = await User.findOne({"requests.telegram.code": startPayload})
                        .select("userProfile username companies telegram requests.telegram");

                    if( !!user ){

                        if( !user.telegram ){
                            user.telegram = {
                                runProtocols: false,
                                chatId: ctx.chat.id
                            }
                        }

                        // Link Telegram chatId to user account; the code is single use.
                        user.telegram.chatId = ctx.chat.id;
                        user.set("requests.telegram.code", undefined);
                        await user.save();
                        linkedUsername = user.username;
                        startLogger.info(`Telegram successfully linked for user: ${user.username}`);

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
                } catch (error: any) {
                    startLogger.err(`Error processing /start command: ${error.message}`);
                    await safeReply(ctx, `An error occurred while linking your account. Please try again.`, startLogger);
                    return;
                }

                if (linkedUsername) {
                    await safeReply(ctx, `Telegram successfully activated for your account: ${linkedUsername}`, startLogger);
                } else {
                    // Invalid, already used or replaced verification code
                    startLogger.warn(`Invalid verification code from chat ${ctx.chat.id}`);
                    await safeReply(ctx, `Invalid verification code. Please generate a new QR code.`, startLogger);
                }
            });

            /**
             * /help command handler
             * Explains what the bot does
             */
            telegrafBot.help(async (ctx) => {
                await safeReply(
                    ctx,
                    `This bot delivers your account notifications. To link an account, scan the Telegram QR code from your profile settings.`,
                    getLogger("telegram-help-command", logger)
                );
            });

            /**
             * /hi command handler
             * Greets the user with their name (only for non-bot users)
             */
            telegrafBot.command('hi', async (ctx) => {
                if( !ctx.from.is_bot ){
                    const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ");
                    await safeReply(ctx, `Hey there ${name}!`, getLogger("telegram-hi-command", logger));
                }
            });

            // Without this, an error escaping a handler would end the long-poll.
            telegrafBot.catch((error: any, ctx) => {
                logger.err(`Unhandled Telegram error for update ${ctx.update.update_id}: ${error?.message ?? error}`);
            });

            // ============================================================================
            // Message Handlers
            // ============================================================================
            //
            // Intentionally NONE. Telegram is a one-way notification transport only:
            // it delivers outbound notifications and handles account linking (/start),
            // but it must never route inbound user messages into the AI-assistant.
            // The AI-assistant is reachable ONLY through the in-app internal chat
            // (see aiAssistantResponder.ts / assistantBrain.ts). Do not re-add a
            // `telegrafBot.on(message(), ...)` handler that answers user messages
            // here — that would re-couple Telegram to the assistant.

            handlersSetup = true;
        }
    }
    catch (e: any){
        logger.err(`Telegram initialization failed: ${e.message}`);
        logger.fail("Failed to initialize Telegram instance");
        return;
    }

    void runLeadershipSupervisor().catch((e: any) => {
        logger.err(`Telegram leadership supervisor failed: ${e.message}`);
    });

    logger.finish("Telegram leadership supervisor started");
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Disconnect from Telegram bot gracefully
 * 
 * Permanently opts this process out of polling, stops the bot if it is
 * polling here, and releases the poller lock so another instance can take
 * over at once. Called by telegramServer's graceful shutdown.
 */
export async function disconnectFromTelegram(): Promise<void> {
    // Set first so the leadership supervisor won't relaunch.
    pollerDisabled = true;
    if (isConnected || launchInProgress) {
        try {
            await telegrafBot.stop();
        } catch (error: any) {
            getLogger("telegram-disconnect").err(`Error stopping Telegram bot: ${error?.message ?? error}`);
        }
    }
    isConnected = false;
    stopTelegramHealthSnapshotPublisher();
    await releasePollerLeadership();
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
function getTelegramHealth(): TelegramHealth {
    const circuitBreakerStats = telegramCircuitBreaker.getStats();
    const counters = telegramCounter.getStats();

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

    // Prefer process uptime (telegramServer) so the card matches assistant/cron/api.
    const lastStart =
        uptimeKeeper.getLastStart("telegramServer")
        || uptimeKeeper.getLastStart("telegram")
        || 0;

    return {
        lastStart,
        lastHeartbeat: isConnected ? Date.now() : undefined,
        connected: isConnected,
        botName: TELEGRAM.NAME || "",
        serverId: `${os.hostname()}:${process.pid}`,
        messages: counters.completedJobs,
        users: 0,
        failed: counters.failedJobs,
        totalMs: counters.totalTime,
        averageMs: counters.averageTime,
        circuitBreaker: circuitBreakerStats
    };
}

/**
 * Telegram health for dashboards that run outside the Telegraf process (e.g. WebSocket server).
 * Reads Redis snapshot written by telegramServer when the bot is connected; falls back to {@link getTelegramHealth}.
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
            lastHeartbeat: typeof parsed.lastHeartbeat === "number" ? parsed.lastHeartbeat : local.lastHeartbeat,
            connected: parsed.connected,
            botName: typeof parsed.botName === "string" ? parsed.botName : local.botName,
            serverId: typeof parsed.serverId === "string" ? parsed.serverId : local.serverId,
            messages: typeof parsed.messages === "number" ? parsed.messages : local.messages,
            users: typeof parsed.users === "number" ? parsed.users : local.users,
            failed: typeof parsed.failed === "number" ? parsed.failed : local.failed,
            totalMs: typeof parsed.totalMs === "number" ? parsed.totalMs : local.totalMs,
            averageMs: typeof parsed.averageMs === "number" ? parsed.averageMs : local.averageMs,
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
