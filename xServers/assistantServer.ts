/**
 * Assistant Server — dedicated AI-channel responder process.
 *
 * Runs the AI-assistant responder as its own process/consumer group, isolated
 * from the shared kafkaServer. This is the ONLY place the AI-channel consumer
 * runs: if this process is down, the AI channel gets no reply. It is also the
 * scale-out home for the assistant once answer-generation becomes heavy (e.g. a
 * real LLM behind `generateAssistantReply`) — run multiple replicas to
 * parallelize across the topic's partitions.
 *
 * Lifecycle mirrors kafkaServer/cronServer:
 *   1. Connect to MongoDB (responder reads/writes messages + channels).
 *   2. Hydrate the UptimeKeeper from the ledger.
 *   3. Connect to Redis.
 *   4. Connect to Kafka (consumer; also needed for DLQ forwarding).
 *   5. Connect to the WebSocket server (M2M) so replies + receipts are delivered.
 *   6. Start the AI-channel consumer.
 *   7. Mark uptime + start the heartbeat.
 *
 * @module assistantServer
 */

import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {connectToMongoDb} from "@coreModule/connections/connectToMongoDb";
import {connectToRedis} from "@coreModule/connections/connectToRedis";
import {connectToKafka} from "@coreModule/connections/connectToKafka";
import {connectToWebSocketServer} from "@coreModule/connections/connectToWebSocketServer";
import {uptimeKeeper} from "@coreModule/utilities/uptime/uptimeKeeper";
import {KAFKA} from "@coreModule/environment";
import {startAiChannelConsumer} from "@coreModule/kafka/aiChannelConsumer";
import {startAssistantHeartbeat, stopAssistantHeartbeat} from "@coreModule/domain/ai/assistantHealth";

/** Global server name identifier for logging and service identification */
global.ServerName = "AssistantServer";

async function setAssistantUp(logger: serverLogger): Promise<void> {

    logger.debug("Connecting to MongoDB instance, retrying until completed...");
    await connectToMongoDb(logger, true);
    logger.debug("Connected to MongoDB instance!");

    logger.debug("Hydrating UptimeKeeper from ledger");
    await uptimeKeeper.hydrate();

    logger.debug("Starting Redis connection supervisor...");
    await connectToRedis(logger);
    logger.debug("Redis connection supervisor started!");

    if (!KAFKA.ENABLED) {
        logger.warn("KAFKA_ENABLED is false — AI-channel consumer cannot start; assistant server idle.");
        return;
    }

    logger.debug("Connecting to Kafka...");
    try {
        await connectToKafka(logger);
        logger.debug("Kafka connected!");
    }
    catch (err: any) {
        // connectToKafka has its own infinite retry; this catch is defensive.
        logger.warn(`Kafka connect failed; consumer will start once Kafka reconnects: ${err?.message}`);
    }

    // The responder delivers replies + receipt updates over WebSocket. Like the
    // API server, this process must hold an M2M client to the WS server, or
    // `pushWebsocketMessage` silently no-ops and nothing reaches the user.
    logger.debug("Connecting to WebSocket server (M2M) for reply delivery...");
    await connectToWebSocketServer(logger);
    logger.debug("WebSocket (M2M) connection supervisor started!");

    logger.debug("Starting AI-channel responder consumer...");
    await startAiChannelConsumer(logger);
    logger.debug("AI-channel responder consumer started!");

    // Publish the responder heartbeat + live throughput stats so this process
    // shows up as a service card in the server-performance UI, like the others.
    // Mark uptime before the first heartbeat so lastStart is available immediately.
    void uptimeKeeper.markStart("assistantServer");
    uptimeKeeper.start();

    logger.debug("Starting assistant responder heartbeat...");
    startAssistantHeartbeat();
}

async function gracefulShutdown(logger: serverLogger): Promise<void> {
    logger.debug("Assistant server shutting down...");
    stopAssistantHeartbeat();
    await uptimeKeeper.markStop("assistantServer");
    process.exit(0);
}

const logger = getLogger("assistant_server");
logger.start("Setting up assistant server");

setAssistantUp(logger)
    .then(() => {
        logger.finish("Done setting up assistant server!");
    })
    .catch((err: any) => {
        logger.err(`Assistant server failed to start: ${err?.message ?? err}`);
        process.exit(1);
    });

process.on("SIGTERM", () => void gracefulShutdown(logger));
process.on("SIGINT", () => void gracefulShutdown(logger));
