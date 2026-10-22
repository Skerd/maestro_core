/**
 * Kafka Consumer Service
 * 
 * Handles consuming messages from Kafka topics and processing them asynchronously.
 * This service processes multiple event types including login history, email notifications,
 * and user management events.
 * 
 * Features:
 * - Backed-off retries: a failing message pauses its partition, then is redelivered
 * - Dead Letter Queue (DLQ) for failed messages after max retries
 * - Graceful error handling with detailed logging
 * - One Kafka consumer per user-event topic (distinct consumer groups from env)
 * 
 * Retry Strategy:
 * - A message gets up to KAFKA.CONSUMER_MAX_RETRIES attempts (default: 3)
 * - After a failed attempt its partition pauses for 5 s, then 20 s, ... (other
 *   partitions keep flowing), and Kafka redelivers the uncommitted offset
 * - Attempts are counted in memory per consumer: the same consumer gets the
 *   offset back; a rebalance in between at worst grants extra attempts
 * - After the last attempt, the message is sent to DLQ topic: `{original_topic}_dlq`;
 *   they can be resent from the Server Performance page or with `yarn kafka:replay-dlq`
 * - If the DLQ is unreachable the message is redelivered, never committed unhandled
 * 
 * DLQ Message Format:
 * - originalTopic: Original Kafka topic name
 * - originalPartition: Original partition number
 * - originalOffset: Original message offset
 * - originalMessage: Original message payload
 * - error: Error details (message and stack trace)
 * - timestamp: When the message was sent to DLQ
 * - retryCount: Number of attempts made
 * 
 * @module kafkaConsumer
 */

import {ensureKafkaTopic, getConsumerInstance} from "@coreModule/connections/connectToKafka";
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
import {ObjectId} from "mongodb";
import ApiAccess from "@coreModule/database/schemas/apiAccess/apiAccess";
import {kafkaCounter} from "@coreModule/utilities/serviceMetrics/serviceCounters";
import {KafkaConsumerRegistration} from "@coreModule/kafka/consumerRegistry";
import {metricsAggregator} from "@coreModule/utilities/timing/metricsAggregator";
import type {EachMessagePayload} from "kafkajs";
import {sendToDeadLetterQueue} from "@coreModule/kafka/deadLetters";

const logger = getLogger("kafka_consumer");

/** Partition pause after a message's first failed attempt; each further failure waits 4x longer. */
const CONSUMER_RETRY_BASE_DELAY_MS = 5_000;

/** Upper bound for that pause (reached while the DLQ itself is unreachable). */
const CONSUMER_RETRY_MAX_DELAY_MS = 5 * 60_000;

async function processApiEvent(event: ApiAccessEvent): Promise<void> {
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
}

async function processApiMetricsEvent(event: ApiAccessEvent): Promise<void> {
    try {
        // Identity/network fields on ApiAccessEvent are PII — do not aggregate them.
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
 * Shared retry + DLQ path for Kafka `eachMessage` handlers.
 *
 * `attempts` belongs to one consumer and is keyed by partition and offset:
 * rethrowing leaves the offset uncommitted, so Kafka redelivers the same offset
 * to this consumer once the paused partition resumes.
 */
async function consumeMessageWithRetry(consumerLogger: serverLogger, attempts: Map<string, number>, {topic, partition, message, pause}: EachMessagePayload, execute: () => Promise<void>): Promise<void> {
    const startedAt = Date.now();
    const attemptKey = `${partition}:${message.offset}`;
    try {
        await execute();
        kafkaCounter.recordSuccess(Date.now() - startedAt);
        attempts.delete(attemptKey);
    } catch (error: any) {
        kafkaCounter.recordFailure(Date.now() - startedAt);
        const attempt = (attempts.get(attemptKey) ?? 0) + 1;
        consumerLogger.err(`Error processing message from topic ${topic}, partition ${partition} (attempt ${attempt}/${KAFKA.CONSUMER_MAX_RETRIES}): ${error.message}`);

        if (attempt >= KAFKA.CONSUMER_MAX_RETRIES) {
            consumerLogger.err(`Message exceeded max retries (${KAFKA.CONSUMER_MAX_RETRIES}). Sending to DLQ.`);
            try {
                await sendToDeadLetterQueue(topic, partition, message, error, attempt, consumerLogger);
                attempts.delete(attemptKey);
                return;
            } catch (dlqError: any) {
                consumerLogger.err(`Failed to send message to DLQ, redelivering it: ${dlqError.message}`);
            }
        }

        attempts.set(attemptKey, attempt);
        // Back off on this partition only; the others keep flowing meanwhile.
        const resume = pause();
        setTimeout(resume, Math.min(CONSUMER_RETRY_BASE_DELAY_MS * 4 ** (attempt - 1), CONSUMER_RETRY_MAX_DELAY_MS));
        throw error;
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

/**
 * Start one Kafka consumer for a topic (same machinery as core user-event consumers).
 *
 * The consumer is registered in the consumer registry once subscribed, and
 * heartbeats there only while it is a member of its group: a crash disconnects
 * it (STOP), and KafkaJS rejoins after a restartable crash (GROUP_JOIN).
 */
export async function addKafkaTopicConsumer(parentLogger: serverLogger | undefined, spec: KafkaUserTopicSpec): Promise<void> {
    if (!spec.groupId || !spec.topic) {
        const skipLog = getLogger("kafka_consumer", parentLogger);
        skipLog.warn(`Skipping consumer "${spec.registryKey}": missing KAFKA_CONSUMER_GROUP or KAFKA_TOPIC in env`);
        return;
    }

    const consumerLogger = getLogger(`kafka_consumer_${spec.registryKey}`, parentLogger);
    consumerLogger.start(`Starting Kafka consumer: ${spec.displayName} (topic=${spec.topic})`);

    const consumer = getConsumerInstance(spec.groupId);
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
    consumer.on(consumer.events.GROUP_JOIN, () => registration.startHeartbeat());
    consumer.on(consumer.events.STOP, () => registration.stopHeartbeat());
    consumer.on(consumer.events.CRASH, ({payload}) => {
        consumerLogger.err(`Consumer crashed (${spec.registryKey}), ${payload.restart ? "restarting" : "not restarting"}: ${payload.error.message}`);
    });

    const attempts = new Map<string, number>();

    try {
        await consumer.connect();
        consumerLogger.info("Kafka consumer connected");

        await ensureKafkaTopic(spec.topic);
        await consumer.subscribe({
            topics: [spec.topic],
            fromBeginning: false
        });

        consumerLogger.info(`Subscribed to topic: ${spec.topic}`);
        await registration.register();

        // Not awaited: `run()` resolves only once the group is joined, which
        // sibling consumers need not wait for. A failed join is reported through
        // the CRASH event, not as a rejection.
        void consumer.run({
            eachMessage: async (payload) => {
                await consumeMessageWithRetry(consumerLogger, attempts, payload, async () => {
                    const eventData = JSON.parse(payload.message.value?.toString() || "{}");
                    if (eventData.eventType !== spec.expectedEventType) {
                        consumerLogger.warn(
                            `Unexpected eventType "${eventData.eventType}" on ${payload.topic}; expected "${spec.expectedEventType}"`
                        );
                        return;
                    }
                    await spec.processEvent(eventData);
                });
            }
        }).catch((err: any) => {
            consumerLogger.err(`Consumer run failed (${spec.registryKey}): ${err?.message}`);
        });

        consumerLogger.finish(`Kafka consumer running: ${spec.displayName}`);
    } catch (error: any) {
        consumerLogger.err(`Failed to start Kafka consumer (${spec.registryKey}): ${error.message}`);
        throw error;
    }
}

/**
 * Starts one Kafka consumer per user-event topic. Each uses its own consumer group
 * from env (`KAFKA_CONSUMER_GROUP_*`) matching the topic (`KAFKA_TOPIC_*`).
 *
 * Runs all consumers concurrently (`Promise.allSettled`); one failing startup does
 * not abort the others.
 *
 * @param parentLogger - Optional parent logger instance for hierarchical logging
 */
export async function startCoreKafkaConsumers(parentLogger?: serverLogger): Promise<void> {

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
            processEvent: (d) => AddToLoginHistory(d as LoginHistoryEvent)
        },
        {
            registryKey: "userActivationEmail",
            displayName: "Activation email",
            groupId: KAFKA.CONSUMER_GROUP.ACTIVATION_EMAIL,
            topic: KAFKA.TOPICS.ACTIVATION_EMAIL,
            expectedEventType: "activation_email",
            processEvent: (d) => SendActivationEmail(d as ActivationEmailEvent)
        },
        {
            registryKey: "userMfaDisableEmail",
            displayName: "MFA disable email",
            groupId: KAFKA.CONSUMER_GROUP.MFA_DISABLE_EMAIL,
            topic: KAFKA.TOPICS.MFA_DISABLE_EMAIL,
            expectedEventType: "mfa_disable_email",
            processEvent: (d) => SendMfaDisableEmail(d as MFADisableEmailEvent)
        },
        {
            registryKey: "userInvitationEmail",
            displayName: "Invitation email",
            groupId: KAFKA.CONSUMER_GROUP.INVITATION_EMAIL,
            topic: KAFKA.TOPICS.INVITATION_EMAIL,
            expectedEventType: "invitation_email",
            processEvent: (d) => SendInvitationEmail(d as InvitationEmailEvent)
        },
        {
            registryKey: "userForgotPasswordEmail",
            displayName: "Forgot password email",
            groupId: KAFKA.CONSUMER_GROUP.FORGOT_PASSWORD_EMAIL,
            topic: KAFKA.TOPICS.FORGOT_PASSWORD_EMAIL,
            expectedEventType: "forgot_password_email",
            processEvent: (d) => SendForgotPasswordEmail(d as ForgotPasswordEmailEvent)
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
            groupId: KAFKA.CONSUMER_GROUP.API_ACCESS + "-metrics", // its own group, so it also receives every api-access event
            topic: KAFKA.TOPICS.API_ACCESS,
            expectedEventType: "api_access",
            processEvent: (d) => processApiMetricsEvent(d as ApiAccessEvent)
        },
    ];

    const results = await Promise.allSettled(
        specs.map((spec) => addKafkaTopicConsumer(parentLogger, spec))
    );

    results.forEach((r, i) => {
        if (r.status === "rejected") {
            umbrellaLog.err(`Consumer "${specs[i].registryKey}" exited with error: ${r.reason}`);
        }
    });

    umbrellaLog.finish("Kafka user-event topic consumers startup pass complete");
}
