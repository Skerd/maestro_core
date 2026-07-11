/**
 * Telegram Server — dedicated Telegraf long-poll + account-linking process.
 *
 * Owns the single getUpdates poller for the bot token (Redis leadership lock
 * still applies if multiple replicas run). Outbound notification sends stay in
 * apiServer via the Bot API without launch(); this process handles inbound
 * commands (/start linking, /help, /hi) and publishes health:telegram.
 *
 * Lifecycle mirrors cronServer/assistantServer:
 *   1. Connect to MongoDB (linking reads/writes users).
 *   2. Hydrate the UptimeKeeper from the ledger.
 *   3. Connect to Redis (poller leadership + health snapshot).
 *   4. Start Telegraf connection supervisor.
 *   5. Mark process uptime + start the heartbeat.
 *
 * @module telegramServer
 */

import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {connectToMongoDb} from "@coreModule/connections/connectToMongoDb";
import {connectToRedis} from "@coreModule/connections/connectToRedis";
import {
    connectToTelegramInstance,
    disconnectFromTelegram,
} from "@coreModule/connections/connectToTelegram";
import {uptimeKeeper} from "@coreModule/utilities/uptime/uptimeKeeper";
import {
    hydrateAllServiceCounters,
    startServiceCountersFlush,
} from "@coreModule/utilities/serviceMetrics/serviceCounters";

/** Global server name identifier for logging and service identification */
global.ServerName = "TelegramServer";

async function setTelegramUp(logger: serverLogger): Promise<void> {
    logger.debug("Connecting to MongoDB instance, retrying until completed...");
    await connectToMongoDb(logger, true);
    logger.debug("Connected to MongoDB instance!");

    logger.debug("Hydrating UptimeKeeper from ledger");
    await uptimeKeeper.hydrate();

    logger.debug("Starting Redis connection supervisor...");
    await connectToRedis(logger);
    logger.debug("Redis connection supervisor started!");

    logger.debug("Hydrating service counters from Redis...");
    await hydrateAllServiceCounters();
    startServiceCountersFlush();
    logger.debug("Service counters hydrated and flush loop started.");

    void uptimeKeeper.markStart("telegramServer");
    uptimeKeeper.start();

    logger.debug("Starting Telegraf connection supervisor...");
    await connectToTelegramInstance(logger);
    logger.debug("Telegraf connection supervisor started!");
}

async function gracefulShutdown(logger: serverLogger): Promise<void> {
    logger.debug("Telegram server shutting down...");
    await disconnectFromTelegram();
    await uptimeKeeper.markStop("telegramServer");
    process.exit(0);
}

const logger = getLogger("telegram_server");
logger.start("Setting up telegram server");

setTelegramUp(logger)
    .then(() => {
        logger.finish("Done setting up telegram server!");
    })
    .catch((err: any) => {
        logger.err(`Telegram server failed to start: ${err?.message ?? err}`);
        process.exit(1);
    });

process.on("SIGTERM", () => void gracefulShutdown(logger));
process.on("SIGINT", () => void gracefulShutdown(logger));
