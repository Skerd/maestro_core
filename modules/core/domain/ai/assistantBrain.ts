/**
 * AI-Assistant Brain — the single seam where the assistant produces a reply.
 *
 * This is intentionally an EMPTY SHELL. The internal AI-assistant chat has no
 * command/protocol logic and no Telegram coupling; it is a plain chat surface
 * waiting for a real LLM to be wired in here. When that happens, this is the
 * ONLY place that changes: call the model from {@link generateAssistantReply}
 * and return its text. Everything upstream (the Kafka consumer, message
 * persistence, WebSocket delivery, receipts) already works and stays untouched.
 *
 * There are deliberately no keyword commands, no protocol registry, and no
 * Telegram references. Do not re-introduce them here — this surface is
 * AI-assistant only.
 *
 * @module assistantBrain
 */

import type {serverLogger} from "@coreModule/loggers/serverLog";

/**
 * Everything the future LLM will need to compose a contextual reply. Kept as a
 * single object so wiring a model in later is a drop-in change with no callsite
 * churn — add fields (history, company profile, etc.) as the model needs them.
 */
export interface AssistantReplyContext {
    /** The user's message text (decrypted, raw). */
    text: string;
    /** The AI channel the conversation belongs to. */
    channelId: string;
    /** The company scope of the conversation. */
    companyId: string;
    /** The human user the assistant is answering. */
    userId: string;
    /** Best available display name for the human, for a personalised reply. */
    userDisplayName?: string;
    /** Language the reply should be produced in, when available. */
    languageCode?: string;
}

/**
 * Placeholder reply returned until a real LLM is connected. Surfaced verbatim in
 * the internal chat so it is obvious the assistant is a shell, not broken.
 */
const NOT_YET_CONNECTED_REPLY =
    "The AI assistant isn't connected yet — this chat is ready and waiting for it to come online.";

/**
 * Produce the assistant's reply to a user message.
 *
 * EMPTY SHELL: returns a fixed placeholder. Replace the body with a real model
 * call (build the prompt from {@link AssistantReplyContext}, invoke the LLM,
 * return its text). Keep it resilient — a thrown error here is counted as a
 * failed answer by the responder and retried by the Kafka consumer.
 *
 * @param context - Message text plus identifiers/context for the reply.
 * @param logger - Optional logger for tracing.
 * @returns The reply text to deliver back into the internal chat.
 */
export async function generateAssistantReply(
    context: AssistantReplyContext,
    logger?: serverLogger
): Promise<string> {
    logger?.debug?.(
        `Assistant brain (shell): no LLM connected; returning placeholder for channel ${context.channelId}`
    );
    return NOT_YET_CONNECTED_REPLY;
}
