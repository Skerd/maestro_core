/**
 * Kafka Server Entry Point
 *
 * Standalone process that owns the Kafka-side consumers:
 *   - User-event topic consumers (one consumer + env group per topic: login history,
 *     activation email, MFA disable, invitation, forgot password)
 *   - Real estate consumers (e.g. reservation client email)
 *   - API access persistence consumer (api_access -> Mongo ApiAccess)
 *
 * The metrics aggregation consumer (api_access -> in-memory MetricsAggregator)
 * intentionally does NOT live here — it runs inside the WebSocket server so
 * the live broadcaster can read the aggregator without IPC overhead.
 *
 * Server Lifecycle:
 *   1. Connect to MongoDB.
 *   2. Hydrate UptimeKeeper from the ledger.
 *   3. Connect to Redis (for retry-count tracking + service counters).
 *   4. Hydrate + start service counter flush loop.
 *   5. Connect Kafka producer (required for DLQ forwarding).
 *   6. Start each consumer; failures are isolated so one bad consumer cannot
 *      take down the others.
 *   7. Start the uptime heartbeat for this process.
 *
 * @module kafkaServer
 */

import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {startAllKafkaConsumers} from "@coreModule/kafka/startAllKafkaConsumers";
import {connectToMongoDb} from "@coreModule/connections/connectToMongoDb";
import {connectToRedis} from "@coreModule/connections/connectToRedis";
import {connectToKafka} from "@coreModule/connections/connectToKafka";
import {uptimeKeeper} from "@coreModule/utilities/uptime/uptimeKeeper";
import {
    hydrateAllServiceCounters,
    startServiceCountersFlush
} from "@coreModule/utilities/serviceMetrics/serviceCounters";
import {metricsAggregator} from "@coreModule/utilities/timing/metricsAggregator";
import {startPerformancePersistence} from "@coreModule/utilities/timing/performancePersistence";
import {startStatsSnapshotPublisher} from "@coreModule/utilities/timing/statsSnapshotPublisher";
import {startPerformanceRollupJobs} from "@coreModule/utilities/timing/performanceRollups";
import {startServerHealthRollupJobs} from "@coreModule/utilities/timing/serverHealthHistory";

/** Global server name identifier for logging and service identification */
global.ServerName = "KafkaServer";

/**
 * Sets up the Kafka server and starts consumers.
 *
 * Initialization sequence:
 *  1. Connect to MongoDB (with retry).
 *  2. Hydrate the UptimeKeeper from the ledger so health responses survive restart.
 *  3. Connect to Redis (consumer needs it for retry-count tracking).
 *  4. Connect to Kafka (producer). Required so the consumer can forward failed
 *     messages to the DLQ — otherwise DLQ writes fail with "producer is disconnected".
 *  5. Start the API access consumer and any other event consumers.
 *  6. Start the uptime heartbeat for this process.
 */
async function setKafkaUp(logger: serverLogger): Promise<void> {

    logger.debug(`Connecting to mongoDB instance, retrying until completed...`);
    await connectToMongoDb(logger, true);
    logger.debug(`Connected to mongoDB instance!`);

    logger.debug(`Hydrating UptimeKeeper from ledger`);
    await uptimeKeeper.hydrate();

    logger.debug(`Starting Redis connection supervisor...`);
    await connectToRedis(logger);
    logger.debug(`Redis connection supervisor started!`);

    logger.debug(`Hydrating service counters from Redis...`);
    await hydrateAllServiceCounters();
    startServiceCountersFlush();
    logger.debug(`Service counters hydrated and flush loop started.`);

    logger.debug(`Connecting Kafka producer (required for DLQ forwarding)...`);
    try {
        await connectToKafka(logger);
        logger.debug(`Kafka producer connected!`);
    }
    catch (err: any) {
        // connectToKafka has its own infinite retry; this catch is defensive.
        logger.warn(`Kafka producer connect failed; DLQ forwarding will be unavailable until reconnect: ${err?.message}`);
    }

    // Discovers and starts all module Kafka consumers under `{module}/kafka/`.
    // Each module starter is isolated via try/catch — one failing module cannot
    // prevent the others from running. Errors are surfaced to the registry.
    logger.debug("Starting all Kafka consumers...");
    await startAllKafkaConsumers(logger);
    logger.debug("Finished starting all Kafka consumers!");

    void uptimeKeeper.markStart("kafkaServer");
    uptimeKeeper.start();

    logger.debug(`Starting aggregator + persistence + snapshot publisher`);
    metricsAggregator.start();
    startPerformancePersistence();
    startStatsSnapshotPublisher();
    startPerformanceRollupJobs(logger);
    startServerHealthRollupJobs(logger);

}

let logger = getLogger("kafkaInitialization");
logger.start("Setting up kafka server");

setKafkaUp(logger).then(() => {
    logger.finish("Done setting up kafka server!");
});
