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
 * - Event publishers report failure (`false`) so callers can handle the event directly
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
 * - key: Partitioning key (usually the user ID)
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
import type {Message} from "kafkajs";

const logger = getLogger("kafka_producer");

/**
 * Check if Kafka publishing is available (enabled and connected).
 *
 * @param logger - Logger instance for warning messages
 * @returns true if Kafka is enabled and connected, false otherwise
 */
function canPublish(logger: serverLogger): boolean {
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
 * @param message - Kafka message object (key, value, headers), or several
 * @param maxRetries - Maximum number of attempts (default: KAFKA.PRODUCER_MAX_RETRIES)
 * @param loggerInstance - Optional logger instance for tracking retry attempts (defaults to module logger)
 * 
 * @throws Error if all retry attempts fail or circuit breaker is open
 */
export async function publishWithRetry(topic: string, message: Message | Message[], maxRetries: number = KAFKA.PRODUCER_MAX_RETRIES, loggerInstance?: serverLogger): Promise<void> {
    // Use module-level logger if none provided
    const log = loggerInstance || logger;

    let lastError: any;

    // Each attempt goes through the breaker on its own, so every failed send
    // counts toward opening it, and an open breaker ends the retries at once.
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            await kafkaCircuitBreaker.execute(async () => {
                const producer = getProducerInstance();
                if (!producer) {
                    throw new Error("Kafka producer is not available");
                }

                await producer.send({
                    topic,
                    messages: Array.isArray(message) ? message : [message]
                });
            });

            if (attempt > 0) {
                log.debug(`Successfully published to ${topic} after ${attempt + 1} attempts`);
            }
            return;
        } catch (error: any) {
            lastError = error;
            if (kafkaCircuitBreaker.isOpen()) {
                break;
            }
            if (attempt < maxRetries - 1) {
                const delay = Math.pow(2, attempt) * KAFKA.PRODUCER_RETRY_DELAY_BASE_MS;
                log.warn(`Failed to publish to ${topic} (attempt ${attempt + 1}/${maxRetries}): ${error.message}. Retrying in ${delay}ms...`);
                await sleep(delay);
            }
        }
    }

    log.err(`Failed to publish to ${topic}: ${lastError?.message}`);
    throw lastError;
}

/**
 * Publish one event to Kafka: JSON value, `key` for partitioning, and the
 * event's `eventType` and `timestamp` as headers. Never throws.
 *
 * Shared by the core publishers below and the feature modules' publishers.
 *
 * @param topic - Topic from env; publishing is skipped when it is not configured
 * @param key - Partitioning key (events with the same key keep their order)
 * @param event - Event payload
 * @param log - Logger for this publish (defaults to module logger)
 * @returns true once Kafka has the event; false when Kafka is disabled,
 *          disconnected, the topic is not configured or every attempt failed —
 *          the caller then handles the event directly instead (e.g. sends the email)
 */
export async function publishEvent(topic: string | undefined, key: string, event: {eventType: string; timestamp: number}, log: serverLogger = logger): Promise<boolean> {
    if (!canPublish(log)) return false;
    if (!topic) {
        log.warn(`No Kafka topic configured for ${event.eventType} events, skipping event publishing`);
        return false;
    }

    try {
        await publishWithRetry(
            topic,
            {
                key,
                value: JSON.stringify(event),
                headers: {
                    'event-type': event.eventType,
                    'timestamp': new Date(event.timestamp).toISOString(),
                },
            },
            KAFKA.PRODUCER_MAX_RETRIES,
            log
        );
        log.debug(`Published ${event.eventType} event (key ${key})`);
        return true;
    }
    catch {
        // publishWithRetry has logged the failure.
        return false;
    }
}

/**
 * Publish login history event (login/authentication attempt, for audit).
 * @returns false when not published; see {@link publishEvent}
 */
export function publishLoginHistoryEvent(params: LoginHistoryEvent): Promise<boolean> {
    return publishEvent(KAFKA.TOPICS.USER_LOGIN_HISTORY, params.userId.toString(), params);
}

/**
 * Publish an AI-channel message event.
 *
 * Fired when a human user posts in their AI-assistant channel; the AI responder
 * ("Layer 2") consumes it and composes the bot's reply. The user's own message
 * is already persisted and delivered independently.
 *
 * @returns false when not published; see {@link publishEvent}
 */
export function publishAiChannelMessageEvent(params: AiChannelMessageEvent, loggerInstance?: serverLogger): Promise<boolean> {
    return publishEvent(KAFKA.TOPICS.AI_CHANNEL_MESSAGE, params.channelId, params, loggerInstance);
}

/**
 * Publish activation email event (account activation for new users).
 * @returns false when not published; see {@link publishEvent}
 */
export function publishActivationEmailEvent(params: ActivationEmailEvent): Promise<boolean> {
    return publishEvent(KAFKA.TOPICS.ACTIVATION_EMAIL, params.userId.toString(), params);
}

/**
 * Publish MFA disable email event.
 * @returns false when not published; see {@link publishEvent}
 */
export function publishMfaDisableEmailEvent(params: MFADisableEmailEvent): Promise<boolean> {
    return publishEvent(KAFKA.TOPICS.MFA_DISABLE_EMAIL, params.userId.toString(), params);
}

/**
 * Publish forgot password email event (password reset).
 * @returns false when not published; see {@link publishEvent}
 */
export function publishForgotPasswordEmailEvent(params: ForgotPasswordEmailEvent): Promise<boolean> {
    return publishEvent(KAFKA.TOPICS.FORGOT_PASSWORD_EMAIL, params.userId.toString(), params);
}

/**
 * Publish invitation email event.
 * @returns false when not published; see {@link publishEvent}
 */
export function publishInvitationEmailEvent(params: InvitationEmailEvent): Promise<boolean> {
    return publishEvent(KAFKA.TOPICS.INVITATION_EMAIL, params.userId.toString(), params);
}

/**
 * Publish API access event (request audit and analytics: endpoint, method, status, duration, ...).
 * @returns false when not published; see {@link publishEvent}
 */
export function publishApiAccessEvent(params: ApiAccessEvent): Promise<boolean> {
    return publishEvent(KAFKA.TOPICS.API_ACCESS, (params.actionUser?.toString() || "") + params.actionNumber, params);
}
