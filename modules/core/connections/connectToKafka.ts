/** Kafka producer/consumer wiring, retry/reconnect, metadata probe, circuit breaker helpers. */

import type {Admin} from "kafkajs";
import {Consumer, ConsumerConfig, Kafka, KafkaConfig, Partitioners, Producer} from "kafkajs";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {KAFKA} from "@coreModule/environment";
import {kafkaCircuitBreaker} from "@coreModule/utilities/circuitBreaker";
import {KafkaHealth} from "armonia/src/modules/core/api/auxiliary/private/serverHealth/serverHealth.dto";
import {uptimeKeeper} from "@coreModule/utilities/uptime/uptimeKeeper";
import {kafkaCounter} from "@coreModule/utilities/serviceMetrics/serviceCounters";
import {getKafkaConsumerStatuses} from "@coreModule/kafka/consumerRegistry";

let kafkaInstance: Kafka | null = null;
let producerInstance: Producer | null = null;
/** Every consumer created via `getConsumerInstance` — disconnected on graceful shutdown. */
const registeredConsumers = new Set<Consumer>();
let retryCount = 0;
let firstConnection = true;
let isConnected = false;
let shutdownHandlersSetup = false;
let producerHandlersSetup = false;
let reconnectInProgress = false;
let connectInProgress = false;
let shuttingDown = false;
let kafkaMetadataProbeAdmin: Admin | null = null;
let kafkaMetadataProbeInterval: ReturnType<typeof setInterval> | null = null;
let reconnectScheduled = false;
let metadataProbeRunning = false;

async function teardownKafkaMetadataProbe(): Promise<void> {
    // Stop the interval first
    if (kafkaMetadataProbeInterval !== null) {
        clearInterval(kafkaMetadataProbeInterval);
        kafkaMetadataProbeInterval = null;
    }

    // Wait for any running probe to complete
    let waitCount = 0;
    while (metadataProbeRunning && waitCount < 50) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        waitCount++;
    }

    // Disconnect admin client
    const admin = kafkaMetadataProbeAdmin;
    kafkaMetadataProbeAdmin = null;
    if (admin) {
        try {
            await admin.disconnect();
        } catch {
            /* ignore */
        }
    }
}

async function waitForRetry(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

export function getKafkaInstance(): Kafka | null {
    if (!KAFKA.ENABLED) {
        return null;
    }
    if (!kafkaInstance) {
        const kafkaConfig: KafkaConfig = {
            clientId: KAFKA.CLIENT_ID,
            brokers: KAFKA.BROKERS,
            retry: {
                retries: 8,
                initialRetryTime: 100,
                multiplier: 2,
                maxRetryTime: 30000,
            },
            requestTimeout: 30000,
            connectionTimeout: 3000,
        };
        kafkaInstance = new Kafka(kafkaConfig);
    }
    return kafkaInstance;
}

export function getProducerInstance(): Producer | null {
    if (!KAFKA.ENABLED) {
        return null;
    }
    const kafka = getKafkaInstance();
    if (!kafka) {
        return null;
    }
    if (!producerInstance) {
        producerInstance = kafka.producer({
            allowAutoTopicCreation: true,
            transactionTimeout: 30000,
            createPartitioner: Partitioners.DefaultPartitioner,
        });
    }
    return producerInstance;
}

/**
 * Creates a dedicated KafkaJS consumer for `groupId`. The `topics` argument is
 * kept for call-site readability; subscription is the caller's responsibility.
 */
export function getConsumerInstance(groupId: string, _topics: string[]): Consumer | null {
    if (!KAFKA.ENABLED) {
        return null;
    }
    const kafka = getKafkaInstance();
    if (!kafka) {
        return null;
    }
    const consumerConfig: ConsumerConfig = {
        groupId,
        sessionTimeout: 30000,
        heartbeatInterval: 3000,
        maxBytesPerPartition: 1048576,
        minBytes: 1,
        maxBytes: 10485760,
        maxWaitTimeInMs: 5000,
    };
    const consumer = kafka.consumer(consumerConfig);
    registeredConsumers.add(consumer);
    return consumer;
}

async function disconnectAllRegisteredConsumers(): Promise<void> {
    await Promise.all(
        [...registeredConsumers].map(async (c) => {
            try {
                await c.disconnect();
            } catch {
                /* ignore */
            }
        })
    );
    registeredConsumers.clear();
}

export async function connectToKafka(parentLogger?: serverLogger): Promise<void> {
    if (!KAFKA.ENABLED) {
        const logger = getLogger("connecting_to_kafka_instance", parentLogger);
        logger.debug("Kafka is disabled in configuration. Skipping connection.");
        return;
    }

    const logger = getLogger("connecting_to_kafka_instance", parentLogger);
    logger.start("Setting up Kafka instance");
    logger.debug(`Kafka target brokers=${JSON.stringify(KAFKA.BROKERS)}, clientId=${KAFKA.CLIENT_ID}`);

    // Forward declare functions that are mutually dependent
    let runKafkaMetadataProbe: () => Promise<void>;
    let scheduleReconnectIfNeeded: (reason: string) => void;

    const startMetadataProbeInterval = (): void => {
        // Clear any existing interval first
        if (kafkaMetadataProbeInterval !== null) {
            clearInterval(kafkaMetadataProbeInterval);
            kafkaMetadataProbeInterval = null;
        }

        // Start new interval
        kafkaMetadataProbeInterval = setInterval(() => {
            void runKafkaMetadataProbe();
        }, KAFKA.CONNECTION_TIMER);
    };

    const connectWithRetry = async (
        initialRetryCount = 0,
        resetConnectionBeforeConnect = false,
    ): Promise<void> => {
        if (connectInProgress) {
            logger.debug("Kafka connection attempt already in progress. Skipping duplicate connect.");
            return;
        }

        connectInProgress = true;
        reconnectScheduled = false;
        let currentRetryCount = initialRetryCount;
        const producer = getProducerInstance();

        if (!producer) {
            logger.err("Kafka producer instance unavailable. Cannot start connection supervisor.");
            connectInProgress = false;
            return;
        }

        if (resetConnectionBeforeConnect) {
            try {
                await producer.disconnect();
            } catch {
                /* ignore */
            }
        }

        try {
            while (!shuttingDown) {
                try {
                    if (currentRetryCount > 0) {
                        logger.info(`Attempting Kafka connection [attempt ${currentRetryCount + 1}]...`);
                    } else {
                        logger.info(`Attempting Kafka connection...`);
                    }
                    await producer.connect();
                    logger.info("Kafka connected successfully");
                    logger.debug(
                        `Kafka producer configured: clientId=${KAFKA.CLIENT_ID}, brokers=${KAFKA.BROKERS.length}, allowAutoTopicCreation=true`,
                    );
                    retryCount = 0;
                    isConnected = true;
                    firstConnection = false;
                    void uptimeKeeper.markStart("kafka");
                    return;
                } catch (error: any) {
                    currentRetryCount++;
                    retryCount = currentRetryCount;
                    isConnected = false;
                    logger.err(`Kafka connection failed: ${error.message}. Retrying in ${KAFKA.CONNECTION_TIMER} ms.`);
                    try {
                        await producer.disconnect();
                    } catch {
                        /* ignore */
                    }
                    if (!shuttingDown) {
                        await waitForRetry(KAFKA.CONNECTION_TIMER);
                    }
                }
            }
        } finally {
            connectInProgress = false;
        }
    };

    const reconnectWithRetry = async (): Promise<void> => {
        if (reconnectInProgress || shuttingDown || connectInProgress) {
            logger.debug("Kafka reconnect already in progress or shutting down. Skipping duplicate reconnect.");
            return;
        }

        reconnectInProgress = true;
        reconnectScheduled = false;
        retryCount = 0;
        isConnected = false;

        // Clean up metadata probe admin client before reconnecting
        await teardownKafkaMetadataProbe();

        try {
            logger.warn(
                `Kafka disconnected. Starting reconnection supervisor. Will retry every ${KAFKA.CONNECTION_TIMER} ms.`,
            );
            await waitForRetry(KAFKA.CONNECTION_TIMER);
            await connectWithRetry(0, true);
            if (isConnected) {
                logger.info(`Kafka reconnected successfully.`);
                // Restart metadata probe interval after successful reconnection
                startMetadataProbeInterval();
            }
        } catch (error: any) {
            logger.err(`Kafka reconnection supervisor error: ${error.message}.`);
        } finally {
            reconnectInProgress = false;
            if (!isConnected && !shuttingDown) {
                scheduleReconnectIfNeeded("reconnection supervisor cleanup");
            }
        }
    };

    scheduleReconnectIfNeeded = (reason: string): void => {
        if (shuttingDown || isConnected) {
            return;
        }
        if (reconnectInProgress || connectInProgress || reconnectScheduled) {
            return;
        }

        reconnectScheduled = true;
        isConnected = false;
        logger.warn(`Kafka connection lost (${reason}). Scheduling reconnect supervisor.`);

        void reconnectWithRetry().catch((err: any) => {
            logger.err(`Kafka reconnection error: ${err.message}.`);
            reconnectScheduled = false;
            if (!shuttingDown && !reconnectInProgress && !isConnected) {
                setTimeout(() => scheduleReconnectIfNeeded("reconnect supervisor retry"), KAFKA.CONNECTION_TIMER);
            }
        });
    };

    runKafkaMetadataProbe = async (): Promise<void> => {
        if (!KAFKA.ENABLED || shuttingDown) {
            return;
        }
        if (connectInProgress || reconnectInProgress || reconnectScheduled || metadataProbeRunning) {
            return;
        }

        if (!isConnected) {
            scheduleReconnectIfNeeded("metadata probe detected disconnection");
            return;
        }

        const kafka = getKafkaInstance();
        if (!kafka) {
            return;
        }

        metadataProbeRunning = true;
        try {
            // Create fresh admin connection if needed
            if (!kafkaMetadataProbeAdmin) {
                kafkaMetadataProbeAdmin = kafka.admin();
                await kafkaMetadataProbeAdmin.connect();
            }

            // Test the connection with a short timeout
            await Promise.race([
                kafkaMetadataProbeAdmin.describeCluster(),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error("Metadata probe timeout")), 5000)
                ),
            ]);
        } catch (error: any) {
            // Clean up broken admin connection
            try {
                await kafkaMetadataProbeAdmin?.disconnect();
            } catch {
                /* ignore */
            }
            kafkaMetadataProbeAdmin = null;

            // Only trigger reconnection if we were previously connected
            if (isConnected) {
                isConnected = false;
                scheduleReconnectIfNeeded(`metadata probe failure: ${error.message}`);
            }
        } finally {
            metadataProbeRunning = false;
        }
    };

    const producer = getProducerInstance();
    if (producer && !producerHandlersSetup) {
        producer.on("producer.disconnect", () => {
            isConnected = false;
            scheduleReconnectIfNeeded("producer disconnect event");
        });
        producer.on("producer.network.request_timeout", (event: any) => {
            isConnected = false;
            scheduleReconnectIfNeeded(event?.error?.message || "producer network request timeout");
        });
        producerHandlersSetup = true;
    }

    const gracefulShutdown = async (signal: "SIGINT" | "SIGTERM"): Promise<void> => {
        logger.info(`Received ${signal}, closing Kafka connection...`);
        try {
            shuttingDown = true;
            await teardownKafkaMetadataProbe();
            if (producerInstance) {
                await producerInstance.disconnect();
            }
            await disconnectAllRegisteredConsumers();
            logger.info("Kafka connection closed successfully");
        } catch {
            logger.err("Error closing Kafka connection");
        }
        process.exit(0);
    };

    if (!shutdownHandlersSetup) {
        process.on("SIGINT", async () => {
            await gracefulShutdown("SIGINT");
        });
        process.on("SIGTERM", async () => {
            await gracefulShutdown("SIGTERM");
        });
        shutdownHandlersSetup = true;
    }

    if (isConnected) {
        logger.debug("Kafka producer already connected. Ensuring metadata probe is active.");
        startMetadataProbeInterval();
        logger.finish("Finished setting up Kafka instance");
        return;
    }

    void connectWithRetry().catch((err: any) => {
        logger.err(`Kafka initial connection error: ${err.message}.`);
        if (!shuttingDown && !reconnectInProgress && !isConnected) {
            setTimeout(() => scheduleReconnectIfNeeded("initial connection failed"), KAFKA.CONNECTION_TIMER);
        }
    });
    startMetadataProbeInterval();
    logger.finish("Finished setting up Kafka instance");
}

export async function disconnectFromKafka(): Promise<void> {
    await teardownKafkaMetadataProbe();
    if (producerInstance) {
        await producerInstance.disconnect();
        producerInstance = null;
    }
    await disconnectAllRegisteredConsumers();
    kafkaInstance = null;
    isConnected = false;
}

export function isKafkaConnected(): boolean {
    return isConnected && KAFKA.ENABLED;
}

export async function executeWithCircuitBreaker<T>(operation: () => Promise<T>): Promise<T> {
    return await kafkaCircuitBreaker.execute(operation);
}

/**
 * Builds the full Kafka health envelope.
 *
 * Async because the consumer roster is read from Redis (cross-process). The
 * roster portion gracefully degrades to an empty list on Redis failure so the
 * caller never has to special-case unavailability.
 *
 * Note: the `connected` field reflects ONLY the producer-side broker
 * connection in this process. The dashboard correlates it with `consumers`
 * to flag the case where the broker is up but consumers are down.
 */
export async function getKafkaHealth(): Promise<KafkaHealth> {
    const connected = isConnected && KAFKA.ENABLED;
    const circuitBreakerStats = kafkaCircuitBreaker.getStats();

    if (circuitBreakerStats.state === "OPEN") {
        const healthLogger = getLogger("kafka_connection_monitor");
        healthLogger.warn?.(`Kafka circuit breaker is OPEN - service unavailable`, {
            circuitBreaker: circuitBreakerStats,
        });
    }

    const counters = kafkaCounter.getStats();
    const consumerList = await getKafkaConsumerStatuses();
    const runningConsumers = consumerList.filter((c) => c.alive).length;

    return {
        completedJobs: counters.completedJobs,
        failedJobs: counters.failedJobs,
        lastStart: uptimeKeeper.getLastStart("kafka"),
        totalTime: counters.totalTime,
        connected,
        enabled: KAFKA.ENABLED,
        clientId: KAFKA.CLIENT_ID || "",
        brokers: KAFKA.BROKERS || [],
        consumers: {
            // `expected` = how many consumers have ever registered (and thus
            // are still in the registry). A consumer that was decommissioned
            // should be removed via `unregister()` or `pruneStaleConsumers()`.
            expected: consumerList.length,
            running: runningConsumers,
            list: consumerList
        }, 
        circuitBreaker: circuitBreakerStats,
    };
}

export function getKafkaCircuitBreakerStats() {
    return kafkaCircuitBreaker.getStats();
}

export function isKafkaCircuitBreakerOpen(): boolean {
    return kafkaCircuitBreaker.isOpen();
}

export function resetKafkaCircuitBreaker(): void {
    kafkaCircuitBreaker.reset();
}
