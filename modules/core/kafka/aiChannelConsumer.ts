/**
 * AI-Channel Kafka Consumer ("Layer 2" transport)
 *
 * Consumes {@link AiChannelMessageEvent}s and hands them to the AI responder.
 *
 * The AI responder runs exclusively in its own dedicated `assistantServer`
 * process: that process calls {@link startAiChannelConsumer} to subscribe to the
 * topic. It is deliberately NOT registered among the shared kafkaServer
 * consumers — the assistant is isolated so it can be scaled and monitored as its
 * own service, and the AI channel gets no reply when the assistantServer is down.
 *
 * @module aiChannelConsumer
 */

import {serverLogger} from "@coreModule/loggers/serverLog";
import {KAFKA} from "@coreModule/environment";
import {addKafkaTopicConsumer, KafkaUserTopicSpec} from "@coreModule/kafka/kafkaConsumer";
import {AiChannelMessageEvent} from "@coreModule/kafka/types";
import {respondToAiChannelMessage} from "@coreModule/domain/ai/aiAssistantResponder";

/** The consumer spec for the AI-channel responder (dedicated assistantServer only). */
export const AI_CHANNEL_CONSUMER_SPEC: KafkaUserTopicSpec = {
    registryKey: "aiChannelMessage",
    displayName: "AI channel responder",
    groupId: KAFKA.CONSUMER_GROUP.AI_CHANNEL_MESSAGE,
    topic: KAFKA.TOPICS.AI_CHANNEL_MESSAGE,
    expectedEventType: "ai_channel_message",
    processEvent: (d) => respondToAiChannelMessage(d as AiChannelMessageEvent)
};

/**
 * Start the AI-channel consumer as a standalone consumer. Called only by the
 * dedicated `assistantServer` process.
 */
export async function startAiChannelConsumer(parentLogger?: serverLogger): Promise<void> {
    await addKafkaTopicConsumer(parentLogger, AI_CHANNEL_CONSUMER_SPEC);
}
