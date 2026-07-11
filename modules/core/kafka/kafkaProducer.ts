/**
 * Kafka Producer Service
 * 
 * Handles publishing messages to Kafka topics with retry logic and circuit breaker protection.
 * This service provides fire-and-forget publishing for asynchronous event processing.
 * 
 * Features:
 * - Automatic retry with exponential backoff
 * - Circuit breaker protection against cascading failures
 * - Graceful degradation when Kafka is disabled or unavailable
 * - Comprehensive error logging without throwing exceptions
 * - Support for multiple event types (login history, emails, etc.)
 * 
 * Retry Strategy:
 * - Exponential backoff: delay = 2^attempt * KAFKA.PRODUCER_RETRY_DELAY_BASE_MS
 * - Maximum retries: KAFKA.PRODUCER_MAX_RETRIES (default: 3)
 * - Example delays: 1s, 2s, 4s for 3 attempts
 * 
 * Circuit Breaker:
 * - Protects against cascading failures when Kafka is down
 * - Automatically opens after threshold failures
 * - Prevents overwhelming the system with failed requests
 * 
 * Message Format:
 * All messages include:
 * - key: User ID (for partitioning)
 * - value: JSON stringified event data
 * - headers: Event metadata (event-type, timestamp)
 * 
 * @module kafkaProducer
 */

import {getProducerInstance, isKafkaConnected} from "@coreModule/connections/connectToKafka";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {KAFKA} from "@coreModule/environment";
import {kafkaCircuitBreaker} from "@coreModule/utilities/circuitBreaker";
import {
    ActivationEmailEvent,
    AiChannelMessageEvent,
    ApiAccessEvent,
    ForgotPasswordEmailEvent,
    InvitationEmailEvent,
    LoginHistoryEvent,
    MFADisableEmailEvent
} from "@coreModule/kafka/types";
import {kafkaCounter} from "@coreModule/utilities/serviceMetrics/serviceCounters";

const logger = getLogger("kafka_producer");

/**
 * Check if Kafka publishing is available (enabled and connected).
 * Shared helper for this module and domain publishers that mirror named email publish flows.
 *
 * @param logger - Logger instance for warning messages
 * @returns true if Kafka is enabled and connected, false otherwise
 */
export function canPublish(logger: serverLogger): boolean {
    if (!KAFKA.ENABLED) {
        logger.debug("Kafka is disabled, skipping event publishing");
        return false;
    }
    if (!isKafkaConnected()) {
        logger.warn("Kafka is not connected, skipping event publishing");
        return false;
    }
    return true;
}

/**
 * Sleep utility for retry delays
 */
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Publish message to Kafka with automatic retry and circuit breaker protection
 * 
 * Implements exponential backoff retry strategy:
 * - Attempt 1: Immediate
 * - Attempt 2: Wait 1s (2^0 * base)
 * - Attempt 3: Wait 2s (2^1 * base)
 * - Attempt 4: Wait 4s (2^2 * base)
 * 
 * The circuit breaker protects against cascading failures by temporarily
 * blocking requests when Kafka is experiencing issues.
 * 
 * @param topic - Kafka topic name to publish to
 * @param message - Kafka message object (key, value, headers)
 * @param maxRetries - Maximum number of retry attempts (default: MAX_RETRIES)
 * @param loggerInstance - Optional logger instance for tracking retry attempts (defaults to module logger)
 * 
 * @throws Error if all retry attempts fail or circuit breaker is open
 * 
 * @example
 * ```typescript
 * await publishWithRetry('user-events', {
 *   key: 'user123',
 *   value: JSON.stringify(eventData),
 *   headers: { 'event-type': 'login' }
 * });
 * ```
 */
export async function publishWithRetry(topic: string, message: any, maxRetries: number = KAFKA.PRODUCER_MAX_RETRIES, loggerInstance?: serverLogger): Promise<void> {
    // Use module-level logger if none provided
    const log = loggerInstance || logger;
    const startedAt = Date.now();

    try {
        await kafkaCircuitBreaker.execute(async () => {
            let lastError: any;

            for (let attempt = 0; attempt < maxRetries; attempt++) {
                try {
                    const producer = getProducerInstance();
                    if (!producer) {
                        throw new Error("Kafka producer is not available");
                    }

                    await producer.send({
                        topic,
                        messages: Array.isArray(message) ? message : [message]
                    });

                    if (attempt > 0) {
                        log.debug(`Successfully published to ${topic} after ${attempt + 1} attempts`);
                    }
                    return;
                } catch (error: any) {
                    lastError = error;
                    if (attempt < maxRetries - 1) {
                        const delay = Math.pow(2, attempt) * KAFKA.PRODUCER_RETRY_DELAY_BASE_MS;
                        log.warn(`Failed to publish to ${topic} (attempt ${attempt + 1}/${maxRetries}): ${error.message}. Retrying in ${delay}ms...`);
                        await sleep(delay);
                    }
                }
            }

            log.err(`Failed to publish to ${topic} after ${maxRetries} attempts: ${lastError?.message}`);
            throw lastError;
        });
        kafkaCounter.recordSuccess(Date.now() - startedAt);
    } catch (error: any) {
        kafkaCounter.recordFailure(Date.now() - startedAt);
        log.warn(`Kafka circuit breaker is open or operation failed for topic ${topic}: ${error.message}`);
        throw error;
    }
}

/**
 * Publish login history event to Kafka
 * 
 * Publishes user login/authentication events for audit and analytics purposes.
 * This is a fire-and-forget operation - errors are logged but don't throw exceptions.
 * 
 * Event includes:
 * - User ID and company ID
 * - User agent and IP address
 * - MFA status
 * - Timestamp
 * - Error details (if authentication failed)
 * 
 * @param params - Login history event data
 * 
 * @example
 * ```typescript
 * await publishLoginHistoryEvent({
 *   eventType: 'login_history',
 *   userId: 'user123',
 *   companyId: 'company456',
 *   userAgent: 'Mozilla/5.0...',
 *   requestIP: '192.168.1.1',
 *   userMfaEnabled: true,
 *   timestamp: Date.now(),
 *   error: null
 * });
 * ```
 */
export async function publishLoginHistoryEvent(params: LoginHistoryEvent): Promise<void> {

    if( !canPublish(logger) ) return;

    const producer = getProducerInstance();
    if (!producer) {
        logger.warn("Kafka producer is not available, skipping login history event");
        return;
    }

    try {
        await publishWithRetry(
            KAFKA.TOPICS.USER_LOGIN_HISTORY,
            {
                key: params.userId.toString(),
                value: JSON.stringify(params),
                headers: {
                    'event-type': 'login_history',
                    'timestamp': new Date(params.timestamp).toISOString(), 
                },
            },
            KAFKA.PRODUCER_MAX_RETRIES,
            logger
        );

        logger.debug(`Published login history event for user ${params.userId}`);
    }
    catch (error: any) {
        logger.err(`Failed to publish login history event for user ${params.userId}: ${error.message}`);
    }
}

/**
 * Publish an AI-channel message event to Kafka.
 *
 * Fired when a human user posts in their AI-assistant channel; the AI responder
 * ("Layer 2") consumes it and composes the bot's reply. Fire-and-forget — the
 * user's own message is already persisted and delivered independently.
 *
 * @param params - AI-channel message event data
 */
export async function publishAiChannelMessageEvent(params: AiChannelMessageEvent, loggerInstance?: serverLogger): Promise<void> {
    const log = loggerInstance || logger;
    if (!canPublish(log)) return;

    try {
        await publishWithRetry(
            KAFKA.TOPICS.AI_CHANNEL_MESSAGE,
            {
                key: params.channelId,
                value: JSON.stringify(params),
                headers: {
                    'event-type': 'ai_channel_message',
                    'timestamp': new Date(params.timestamp).toISOString(),
                },
            },
            KAFKA.PRODUCER_MAX_RETRIES,
            log
        );

        log.debug(`Published AI-channel message event for channel ${params.channelId}`);
    }
    catch (error: any) {
        log.err(`Failed to publish AI-channel message event for channel ${params.channelId}: ${error.message}`);
    }
}

/**
 * Publish activation email event to Kafka
 * 
 * Publishes events for sending account activation emails to new users.
 * This is a fire-and-forget operation - errors are logged but don't throw exceptions.
 * 
 * @param params - Activation email event data (email, userId, activationCode, etc.)
 * 
 * @example
 * ```typescript
 * await publishActivationEmailEvent({
 *   eventType: 'activation_email',
 *   email: 'user@example.com',
 *   userId: 'user123',
 *   fullName: 'John Doe',
 *   activationCode: 'ABC123',
 *   languageCode: 'en-US',
 *   timestamp: Date.now()
 * });
 * ```
 */
export async function publishActivationEmailEvent(params: ActivationEmailEvent): Promise<void> {
    if (!canPublish(logger)) return;

    const producer = getProducerInstance();
    if (!producer) {
        logger.warn("Kafka producer is not available, skipping activation email event");
        return;
    }

    try {
        await publishWithRetry(
            KAFKA.TOPICS.ACTIVATION_EMAIL,
            {
                key: params.userId.toString(),
                value: JSON.stringify(params),
                headers: {
                    'event-type': 'activation_email',
                    'timestamp': new Date(params.timestamp).toISOString(),
                },
            },
            KAFKA.PRODUCER_MAX_RETRIES,
            logger
        );

        logger.debug(`Published activation email event for user ${params.userId}`);
    }
    catch (error: any) {
        logger.err(`Failed to publish activation email event for user ${params.userId}: ${error.message}`);
    }
}


/**
 * Publish MFA disable email event to Kafka
 * 
 * Publishes events for sending MFA disable notification emails to users.
 * This is a fire-and-forget operation - errors are logged but don't throw exceptions.
 * 
 * @param params - MFA disable email event data (email, userId, resetCode, etc.)
 * 
 * @example
 * ```typescript
 * await publishMfaDisableEmailEvent({
 *   eventType: 'mfa_disable_email',
 *   email: 'user@example.com',
 *   userId: 'user123',
 *   fullName: 'John Doe',
 *   resetCode: 'XYZ789',
 *   languageCode: 'en-US',
 *   timestamp: Date.now()
 * });
 * ```
 */
export async function publishMfaDisableEmailEvent(params: MFADisableEmailEvent): Promise<void> {
    if (!canPublish(logger)) return;

    const producer = getProducerInstance();
    if (!producer) {
        logger.warn("Kafka producer is not available, skipping MFA disable email event");
        return;
    }

    try {
        await publishWithRetry(
            KAFKA.TOPICS.MFA_DISABLE_EMAIL,
            {
                key: params.userId.toString(),
                value: JSON.stringify(params),
                headers: {
                    'event-type': 'mfa_disable_email',
                    'timestamp': new Date(params.timestamp).toISOString(),
                },
            },
            KAFKA.PRODUCER_MAX_RETRIES,
            logger
        );

        logger.debug(`Published MFA disable email event for user ${params.userId}`);
    }
    catch (error: any) {
        logger.err(`Failed to publish MFA disable email event for user ${params.userId}: ${error.message}`);
    }
}


/**
 * Publish forgot password email event to Kafka
 * 
 * Publishes events for sending password reset emails to users.
 * This is a fire-and-forget operation - errors are logged but don't throw exceptions.
 * 
 * @param params - Forgot password email event data (email, userId, resetCode, etc.)
 * 
 * @example
 * ```typescript
 * await publishForgotPasswordEmailEvent({
 *   eventType: 'forgot_password_email',
 *   email: 'user@example.com',
 *   userId: 'user123',
 *   fullName: 'John Doe',
 *   resetCode: 'RESET456',
 *   expiresAfterOpening: true,
 *   languageCode: 'en-US',
 *   timestamp: Date.now()
 * });
 * ```
 */
export async function publishForgotPasswordEmailEvent(params: ForgotPasswordEmailEvent): Promise<void> {
    if (!canPublish(logger)) return;

    const producer = getProducerInstance();
    if (!producer) {
        logger.warn("Kafka producer is not available, skipping forgot password email event");
        return;
    }

    try {
        await publishWithRetry(
            KAFKA.TOPICS.FORGOT_PASSWORD_EMAIL,
            {
                key: params.userId.toString(),
                value: JSON.stringify(params),
                headers: {
                    'event-type': 'forgot_password_email',
                    'timestamp': new Date(params.timestamp).toISOString(),
                },
            },
            KAFKA.PRODUCER_MAX_RETRIES,
            logger
        );

        logger.debug(`Published forgot password email event for user ${params.userId}`);
    }
    catch (error: any) {
        logger.err(`Failed to publish forgot password email event for user ${params.userId}: ${error.message}`);
    }
}

/**
 * Publish invitation email event to Kafka
 * 
 * Publishes events for sending user invitation emails.
 * This is a fire-and-forget operation - errors are logged but don't throw exceptions.
 * 
 * @param params - Invitation email event data (email, userId, invitationCode, company info, etc.)
 * 
 * @example
 * ```typescript
 * await publishInvitationEmailEvent({
 *   eventType: 'invitation_email',
 *   email: 'newuser@example.com',
 *   userId: 'user123',
 *   fullName: 'Jane Doe',
 *   welcomeMessage: 'Welcome to our platform!',
 *   invitationCode: 'INV789',
 *   inviterName: 'John Admin',
 *   companyName: 'Acme Corp',
 *   languageCode: 'en-US',
 *   timestamp: Date.now()
 * });
 * ```
 */
export async function publishInvitationEmailEvent(params: InvitationEmailEvent): Promise<void> {
    if (!canPublish(logger)) return;

    const producer = getProducerInstance();
    if (!producer) {
        logger.warn("Kafka producer is not available, skipping invitation email event");
        return;
    }

    try {
        await publishWithRetry(
            KAFKA.TOPICS.INVITATION_EMAIL,
            {
                key: params.userId.toString(),
                value: JSON.stringify(params),
                headers: {
                    'event-type': 'invitation_email',
                    'timestamp': new Date(params.timestamp).toISOString(),
                },
            },
            KAFKA.PRODUCER_MAX_RETRIES,
            logger
        );

        logger.debug(`Published invitation email event for user ${params.userId}`);
    }
    catch (error: any) {
        logger.err(`Failed to publish invitation email event for user ${params.userId}: ${error.message}`);
    }
}

/**
 * Publish API access event to Kafka
 *
 * Publishes events for API request audit and analytics (endpoint, method, status, duration, etc.).
 * This is a fire-and-forget operation - errors are logged but don't throw exceptions.
 *
 * @param params - API access event data (endpoint, method, statusCode, actionUser, etc.)
 *
 * @example
 * ```typescript
 * await publishApiAccessEvent({
 *   eventType: 'api_access',
 *   endpoint: '/api/users',
 *   method: 'GET',
 *   statusCode: 200,
 *   duration: 45,
 *   actionUser: 'user123',
 *   actionNumber: '1',
 *   user: 'user123',
 *   company: 'company456',
 *   deviceId: 'device-abc',
 *   userAgent: 'Mozilla/5.0...',
 *   requestIp: '192.168.1.1',
 *   source: 'web',
 *   timestamp: Date.now()
 * });
 * ```
 */
export async function publishApiAccessEvent(params: ApiAccessEvent): Promise<void> {
    if (!canPublish(logger)) return;

    const producer = getProducerInstance();
    if (!producer) {
        logger.warn("Kafka producer is not available, skipping api access event");
        return;
    }

    try {
        await publishWithRetry(
            KAFKA.TOPICS.API_ACCESS,
            {
                key: (params.actionUser?.toString() || "") + params.actionNumber,
                value: JSON.stringify(params),
                headers: {
                    'event-type': 'api_access',
                    'timestamp': new Date(params.timestamp).toISOString(),
                },
            },
            KAFKA.PRODUCER_MAX_RETRIES,
            logger
        );

        logger.debug(`Published api access event for user ${params.actionUser}`);
    }
    catch (error: any) {
        logger.err(`Failed to publish api access event for user ${params.actionUser}: ${error.message}`);
    }
}

