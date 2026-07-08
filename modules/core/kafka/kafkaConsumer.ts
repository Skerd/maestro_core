/**
 * Kafka Consumer Service
 * 
 * Handles consuming messages from Kafka topics and processing them asynchronously.
 * This service processes multiple event types including login history, email notifications,
 * and user management events.
 * 
 * Features:
 * - Automatic retry mechanism with configurable max retries
 * - Dead Letter Queue (DLQ) for failed messages after max retries
 * - Redis-based retry tracking to prevent infinite retry loops
 * - Graceful error handling with detailed logging
 * - One Kafka consumer per user-event topic (distinct consumer groups from env)
 * 
 * Retry Strategy:
 * - Messages are retried up to MAX_RETRIES times (default: 3)
 * - Retry count is tracked in Redis with 1-hour TTL
 * - After max retries, messages are sent to DLQ topic: `{original_topic}_dlq`
 * 
 * DLQ Message Format:
 * - originalTopic: Original Kafka topic name
 * - originalPartition: Original partition number
 * - originalOffset: Original message offset
 * - originalMessage: Original message payload
 * - error: Error details (message and stack trace)
 * - timestamp: When the message was sent to DLQ
 * - retryCount: Number of retry attempts
 * 
 * @module kafkaConsumer
 */

import {getConsumerInstance, getProducerInstance} from "@coreModule/connections/connectToKafka";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {KAFKA} from "@coreModule/environment";
import {
    ActivationEmailEvent,
    ApiAccessEvent,
    ForgotPasswordEmailEvent,
    InvitationEmailEvent,
    LoginHistoryEvent,
    MFADisableEmailEvent
} from "@coreModule/kafka/types";
import {
    AddToLoginHistory,
    SendActivationEmail,
    SendForgotPasswordEmail,
    SendInvitationEmail,
    SendMfaDisableEmail
} from "@coreModule/utilities/database/user";
import {getRedisClient, isRedisConnected} from "@coreModule/connections/connectToRedis";
import {ObjectId} from "mongodb";
import ApiAccess from "@coreModule/database/schemas/apiAccess/apiAccess";
import {kafkaCounter} from "@coreModule/utilities/serviceMetrics/serviceCounters";
import {KafkaConsumerRegistration} from "@coreModule/kafka/consumerRegistry";
import {metricsAggregator} from "@coreModule/utilities/timing/metricsAggregator";

const logger = getLogger("kafka_consumer");

/** Suffix appended to topic name for Dead Letter Queue */
const DLQ_TOPIC_SUFFIX = '_dlq';

/** TTL for retry count tracking in Redis (1 hour) */
const RETRY_COUNT_TTL_SECONDS = 3600;

/**
 * Process login history event
 * This replicates the logic from UserSchema.methods.addLoginHistory
 */
async function processLoginHistoryEvent(event: LoginHistoryEvent): Promise<void> {
    try {
        await AddToLoginHistory(event);
        logger.debug(`Processed login history event for user ${event.userId}`);
    }
    catch (error: any) {
        logger.err(`Failed to process login history event: ${error.message}`);
        throw error; // Re-throw to trigger retry mechanism
    }
}

/**
 * Process activation email event
 * This replicates the logic from UserSchema.methods.sendActivationEmail
 */
async function processActivationEmailEvent(event: ActivationEmailEvent): Promise<void> {
    try {
        await SendActivationEmail(event);
        logger.debug(`Processed activation email event for user ${event.userId}`);
    }
    catch (error: any) {
        logger.err(`Failed to process activation email event: ${error.message}`);
        throw error; // Re-throw to trigger retry mechanism
    }
}

/**
 * Process MFA disable email event
 * 
 * Handles sending MFA disable notification emails to users.
 * This replicates the logic from UserSchema.methods.sendDisableMfaEmail
 * 
 * @param event - MFA disable email event data
 * @throws Re-throws error to trigger retry mechanism
 */
async function processMfaDisableEmailEvent(event: MFADisableEmailEvent): Promise<void> {
    try {
        await SendMfaDisableEmail(event);
        logger.debug(`Processed mfa disable email event for user ${event.userId}`);
    }
    catch (error: any) {
        logger.err(`Failed to process mfa disable email event: ${error.message}`);
        throw error; // Re-throw to trigger retry mechanism
    }
}

/**
 * Process invitation email event
 * 
 * Handles sending invitation emails to new users.
 * 
 * @param event - Invitation email event data
 * @throws Re-throws error to trigger retry mechanism
 */
async function processInvitationEmailEvent(event: InvitationEmailEvent): Promise<void> {
    try {
        await SendInvitationEmail(event);
        logger.debug(`Processed invitation email event for user ${event.userId}`);
    }
    catch (error: any) {
        logger.err(`Failed to process invitation email event: ${error.message}`);
        throw error; // Re-throw to trigger retry mechanism
    }
}

/**
 * Process forgot-password email event (Kafka path mirrors other email handlers).
 */
async function processForgotPasswordEmailEvent(event: ForgotPasswordEmailEvent): Promise<void> {
    try {
        await SendForgotPasswordEmail(event);
        logger.debug(`Processed forgot password email event for user ${event.userId}`);
    }
    catch (error: any) {
        logger.err(`Failed to process forgot password email event: ${error.message}`);
        throw error;
    }
}

async function processApiEvent(event: ApiAccessEvent): Promise<void> {
    try {
        await new ApiAccess({
            endpoint: event.endpoint,
            method: event.method,
            statusCode: event.statusCode,
            duration: event.duration,
            errorType: event.errorType || undefined,
            actionUser: event.actionUser ? new ObjectId(event.actionUser) : undefined,
            actionNumber: event.actionNumber,
            deviceId: event.deviceId || undefined,
            userAgent: event.userAgent || undefined,
            requestIp: event.requestIp || undefined,
            source: event.source || undefined,
            company: event.company ? new ObjectId(event.company) : undefined,
            createdBy: event.user ? new ObjectId(event.user) : undefined
        }).save();
        logger.debug(`Processed api event`);
    }
    catch (error: any){
        logger.err(`Failed to process api event: ${error.message}`);
        throw error;
    }
}

async function processApiMetricsEvent(event: ApiAccessEvent): Promise<void> {
    try {
        metricsAggregator.addSample({
            method: event.method || "UNKNOWN",
            endpoint: event.endpoint || "unknown",
            durationMs: typeof event.duration === "number" ? event.duration : 0,
            statusCode: typeof event.statusCode === "number" ? event.statusCode : 0,
            timestamp: typeof event.timestamp === "number" ? event.timestamp : Date.now()
        });
        logger.debug(`Processed api metrics event`);
    }
    catch (error: any){
        logger.err(`Failed to process api metrics event: ${error.message}`);
    }
}

/**
 * Send failed message to Dead Letter Queue (DLQ)
 *
 * After a message has exceeded the maximum retry attempts, it is sent to a DLQ
 * topic for manual inspection and potential reprocessing.
 */
async function sendToDeadLetterQueue(topic: string, message: any, error: Error, log: serverLogger): Promise<void> {
    try {
        const producer = getProducerInstance();
        if (!producer) {
            log.err("Kafka producer not available for DLQ");
            return;
        }

        const dlqTopic = `${topic}${DLQ_TOPIC_SUFFIX}`;

        await producer.send({
            topic: dlqTopic,
            messages: [{
                key: message.key?.toString() || "unknown",
                value: JSON.stringify({
                    originalTopic: topic,
                    originalPartition: message.partition,
                    originalOffset: message.offset,
                    originalMessage: message.value?.toString(),
                    error: {
                        message: error.message,
                        stack: error.stack
                    },
                    timestamp: new Date().toISOString(),
                    retryCount: KAFKA.CONSUMER_MAX_RETRIES
                }),
                headers: {
                    "original-topic": topic,
                    "error-type": error.constructor.name,
                    "dlq-timestamp": new Date().toISOString()
                }
            }]
        });

        log.warn(`Sent message to DLQ: ${dlqTopic}`);
    } catch (dlqError: any) {
        log.err(`Failed to send message to DLQ: ${dlqError.message}`);
    }
}

/**
 * Shared retry + DLQ path for Kafka `eachMessage` handlers.
 */
async function consumeMessageWithRetry(consumerLogger: serverLogger, topic: string, partition: number, message: { offset: string; key?: Buffer | null; value?: Buffer | null; partition?: number }, execute: () => Promise<void>): Promise<void> {
    const startedAt = Date.now();
    try {
        await execute();
        kafkaCounter.recordSuccess(Date.now() - startedAt);
    } catch (error: any) {
        kafkaCounter.recordFailure(Date.now() - startedAt);
        consumerLogger.err(`Error processing message from topic ${topic}, partition ${partition}: ${error.message}`);

        const retryKey = `kafka:retry:${topic}:${partition}:${message.offset}`;
        let retryCount = 0;

        if (isRedisConnected()) {
            try {
                const cached = await getRedisClient().get(retryKey);
                retryCount = cached ? parseInt(cached, 10) : 0;
            } catch (redisError) {
                consumerLogger.warn(`Failed to get retry count from Redis: ${(redisError as Error).message}`);
            }
        }

        retryCount++;

        if (retryCount >= KAFKA.CONSUMER_MAX_RETRIES) {
            consumerLogger.err(`Message exceeded max retries (${KAFKA.CONSUMER_MAX_RETRIES}). Sending to DLQ.`);
            await sendToDeadLetterQueue(topic, message, error, consumerLogger);

            if (isRedisConnected()) {
                try {
                    await getRedisClient().del(retryKey);
                } catch (redisError) {
                    consumerLogger.warn(`Failed to clear retry count from Redis: ${(redisError as Error).message}`);
                }
            }
        }
        else {
            if (isRedisConnected()) {
                try {
                    await getRedisClient().setEx(retryKey, RETRY_COUNT_TTL_SECONDS, retryCount.toString());
                } catch (redisError) {
                    consumerLogger.warn(`Failed to store retry count in Redis: ${(redisError as Error).message}`);
                }
            }

            throw error;
        }
    }
}

/** Spec for a single-topic user/domain consumer (shared with feature modules, e.g. real estate). */
export type KafkaUserTopicSpec = {
    registryKey: string;
    displayName: string;
    groupId: string | undefined;
    topic: string | undefined;
    expectedEventType: string;
    processEvent: (eventData: any) => Promise<void>;
};

async function startSingleUserTopicConsumer(parentLogger: serverLogger | undefined, spec: KafkaUserTopicSpec): Promise<void> {
    if (!spec.groupId || !spec.topic) {
        const skipLog = getLogger("kafka_consumer", parentLogger);
        skipLog.warn(`Skipping consumer "${spec.registryKey}": missing KAFKA_CONSUMER_GROUP or KAFKA_TOPIC in env`);
        return;
    }

    const consumerLogger = getLogger(`kafka_consumer_${spec.registryKey}`, parentLogger);
    consumerLogger.start(`Starting Kafka consumer: ${spec.displayName} (topic=${spec.topic})`);

    const consumer = getConsumerInstance(spec.groupId, [spec.topic]);
    if (!consumer) {
        consumerLogger.err("Failed to get Kafka consumer instance");
        return;
    }

    const registration = new KafkaConsumerRegistration(
        spec.registryKey,
        spec.displayName,
        spec.groupId,
        spec.topic
    );

    try {
        await consumer.connect();
        consumerLogger.info("Kafka consumer connected");
        await registration.register();
        registration.startHeartbeat();

        await consumer.subscribe({
            topics: [spec.topic],
            fromBeginning: false
        });

        consumerLogger.info(`Subscribed to topic: ${spec.topic}`);

        // Do not await `run()` — it only settles when the consumer stops. The
        // kafka server must continue starting sibling consumers and the API
        // access consumer after this returns.
        void consumer.run({
            eachMessage: async ({ topic, partition, message }) => {
                await consumeMessageWithRetry(consumerLogger, topic, partition, message, async () => {
                    const eventData = JSON.parse(message.value?.toString() || "{}");
                    if (eventData.eventType !== spec.expectedEventType) {
                        consumerLogger.warn(
                            `Unexpected eventType "${eventData.eventType}" on ${topic}; expected "${spec.expectedEventType}"`
                        );
                        return;
                    }
                    await spec.processEvent(eventData);
                });
            }
        }).catch((err: any) => {
            consumerLogger.err(`Consumer run loop crashed (${spec.registryKey}): ${err?.message}`);
        });

        consumerLogger.finish(`Kafka consumer running: ${spec.displayName}`);
    } catch (error: any) {
        consumerLogger.err(`Failed to start Kafka consumer (${spec.registryKey}): ${error.message}`);
        throw error;
    }
}

/**
 * Start one Kafka consumer for a topic (same machinery as core user-event consumers).
 */
export async function addKafkaTopicConsumer(parentLogger: serverLogger | undefined, spec: KafkaUserTopicSpec): Promise<void> {
    return startSingleUserTopicConsumer(parentLogger, spec);
}

/**
 * Starts one Kafka consumer per user-event topic. Each uses its own consumer group
 * from env (`KAFKA_CONSUMER_GROUP_*`) matching the topic (`KAFKA_TOPIC_*`).
 *
 * Runs all consumers concurrently (`Promise.allSettled`); one failing startup does
 * not abort the others. Each `consumer.run()` blocks until that consumer stops.
 *
 * @param parentLogger - Optional parent logger instance for hierarchical logging
 */
export async function startAllKafkaEventsConsumer(parentLogger?: serverLogger): Promise<void> {

    if (!KAFKA.ENABLED) {
        const log = getLogger("kafka_consumer", parentLogger);
        log.warn("Kafka is disabled in configuration. Skipping consumer startup.");
        return;
    }

    const umbrellaLog = getLogger("kafka_consumer", parentLogger);
    umbrellaLog.start("Starting Kafka user-event topic consumers (one per topic)");

    const specs: KafkaUserTopicSpec[] = [
        {
            registryKey: "userLoginHistory",
            displayName: "Login history",
            groupId: KAFKA.CONSUMER_GROUP.LOGIN_HISTORY,
            topic: KAFKA.TOPICS.USER_LOGIN_HISTORY,
            expectedEventType: "login_history",
            processEvent: (d) => processLoginHistoryEvent(d as LoginHistoryEvent)
        },
        {
            registryKey: "userActivationEmail",
            displayName: "Activation email",
            groupId: KAFKA.CONSUMER_GROUP.ACTIVATION_EMAIL,
            topic: KAFKA.TOPICS.ACTIVATION_EMAIL,
            expectedEventType: "activation_email",
            processEvent: (d) => processActivationEmailEvent(d as ActivationEmailEvent)
        },
        {
            registryKey: "userMfaDisableEmail",
            displayName: "MFA disable email",
            groupId: KAFKA.CONSUMER_GROUP.MFA_DISABLE_EMAIL,
            topic: KAFKA.TOPICS.MFA_DISABLE_EMAIL,
            expectedEventType: "mfa_disable_email",
            processEvent: (d) => processMfaDisableEmailEvent(d as MFADisableEmailEvent)
        },
        {
            registryKey: "userInvitationEmail",
            displayName: "Invitation email",
            groupId: KAFKA.CONSUMER_GROUP.INVITATION_EMAIL,
            topic: KAFKA.TOPICS.INVITATION_EMAIL,
            expectedEventType: "invitation_email",
            processEvent: (d) => processInvitationEmailEvent(d as InvitationEmailEvent)
        },
        {
            registryKey: "userForgotPasswordEmail",
            displayName: "Forgot password email",
            groupId: KAFKA.CONSUMER_GROUP.FORGOT_PASSWORD_EMAIL,
            topic: KAFKA.TOPICS.FORGOT_PASSWORD_EMAIL,
            expectedEventType: "forgot_password_email",
            processEvent: (d) => processForgotPasswordEmailEvent(d as ForgotPasswordEmailEvent)
        },
        {
            registryKey: "apiAccessPersistence",
            displayName: "API access persistence",
            groupId: KAFKA.CONSUMER_GROUP.API_ACCESS,
            topic: KAFKA.TOPICS.API_ACCESS,
            expectedEventType: "api_access",
            processEvent: (d) => processApiEvent(d as ApiAccessEvent)
        },
        {
            registryKey: "apiAccessMetrics",
            displayName: "API access metrics",
            groupId: KAFKA.CONSUMER_GROUP.API_ACCESS + "-metrics", // this si to differentiate from api aceess
            topic: KAFKA.TOPICS.API_ACCESS,
            expectedEventType: "api_access",
            processEvent: (d) => processApiMetricsEvent(d as ApiAccessEvent)
        },
    ];

    const results = await Promise.allSettled(
        specs.map((spec) => startSingleUserTopicConsumer(parentLogger, spec))
    );

    results.forEach((r, i) => {
        if (r.status === "rejected") {
            umbrellaLog.err(`Consumer "${specs[i].registryKey}" exited with error: ${r.reason}`);
        }
    });

    umbrellaLog.finish("Kafka user-event topic consumers startup pass complete");
}
