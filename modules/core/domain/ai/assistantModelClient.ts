/**
 * Model-backend dispatcher.
 *
 * The assistant brain calls this instead of a specific client, so switching
 * between a local Ollama model and the hosted Claude API is an env change
 * (`AI_ASSISTANT_PROVIDER`) rather than a code change. Both clients take and
 * return the same shapes.
 *
 * @module assistantModelClient
 */

import {AI_ASSISTANT} from "@coreModule/environment";
import {
    ollamaChat,
    type OllamaAssistantMessage,
    type OllamaChatMessage,
    type OllamaChatOptions,
} from "@coreModule/domain/ai/ollamaClient";
import {anthropicChat} from "@coreModule/domain/ai/anthropicClient";

/** Send a transcript to whichever backend is configured. */
export async function assistantChat(
    messages: OllamaChatMessage[],
    options: OllamaChatOptions = {},
): Promise<OllamaAssistantMessage> {
    if (AI_ASSISTANT.PROVIDER === "anthropic") {
        return anthropicChat(messages, options);
    }
    return ollamaChat(messages, options);
}
