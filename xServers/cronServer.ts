/**
 * Cron Server — dedicated scheduler + Kafka cron worker process.
 *
 * @module cronServer
 */

import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {connectToMongoDb} from "@coreModule/connections/connectToMongoDb";
import {connectToRedis} from "@coreModule/connections/connectToRedis";
import {connectToKafka} from "@coreModule/connections/connectToKafka";
import {uptimeKeeper} from "@coreModule/utilities/uptime/uptimeKeeper";
import {CRON} from "@coreModule/environment";
import {loadAllCronHandlers} from "@coreModule/cronjobs/bootstrap/loadAllHandlers";
import {seedPlatformCronJobs} from "@coreModule/cronjobs/bootstrap/seedPlatformJobs";
import {schedulerEngine} from "@coreModule/cronjobs/engine/schedulerEngine";
import "@coreModule/database/schemas/cronJob/cronJob";
import "@coreModule/database/schemas/cronExecution/cronExecution";
import "@coreModule/database/schemas/cronLock/cronLock";

global.ServerName = "CronServer";

async function setCronUp(logger: serverLogger): Promise<void> {
    logger.debug("Connecting to MongoDB...");
    await connectToMongoDb(logger, true);

    logger.debug("Connecting to Redis...");
    await connectToRedis(logger);

    if (CRON.ENABLED) {
        logger.debug("Connecting to Kafka (cron queue)...");
        try {
            await connectToKafka(logger);
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            logger.warn(`Kafka connect failed (queue strategy unavailable): ${msg}`);
        }

        await loadAllCronHandlers(logger);
        if (CRON.SEED_PLATFORM_JOBS) {
            await seedPlatformCronJobs();
        }

        await uptimeKeeper.hydrate();
        await uptimeKeeper.markStart("cronServer");
        uptimeKeeper.start();
        await schedulerEngine.start(logger);
        logger.debug("Cron scheduler engine started");
    } else {
        logger.warn("CRON_ENABLED is false — scheduler not started");
    }
}

async function gracefulShutdown(logger: serverLogger): Promise<void> {
    logger.debug("Cron server shutting down...");
    await schedulerEngine.stop();
    await uptimeKeeper.markStop("cronServer");
    process.exit(0);
}

const logger = getLogger("cron_server");

setCronUp(logger).catch(err => {
    logger.err(`Cron server failed to start: ${err?.message ?? err}`);
    process.exit(1);
});

process.on("SIGTERM", () => void gracefulShutdown(logger));
process.on("SIGINT", () => void gracefulShutdown(logger));
