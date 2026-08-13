/**
 * Claude (Anthropic API) chat client.
 *
 * The hosted alternative to {@link module:ollamaClient}. It deliberately exposes
 * the SAME shape as `ollamaChat` — take a transcript, optionally advertise
 * tools, return one assistant message — so the assistant brain's loop is
 * identical whichever backend answers, and the provider is a one-line env swap.
 *
 * TRANSLATION NOTES — the two wire formats differ in three ways that matter,
 * and each is handled here rather than leaking into the brain:
 *
 *   1. `system` is a top-level request field for Claude, not a message role.
 *      System turns are pulled out of the transcript and concatenated.
 *   2. Tool results are paired to their call by `tool_use_id`, and ALL results
 *      for one assistant turn must arrive in a SINGLE user message. The brain
 *      appends them as consecutive `tool` turns, so they are grouped here.
 *   3. Assistant turns must be echoed back with their content blocks intact —
 *      including thinking blocks, which the API rejects the turn without when
 *      thinking is on. The raw blocks ride along on `raw` and are replayed
 *      verbatim rather than reconstructed from text.
 *
 * @module anthropicClient
 */

import Anthropic from "@anthropic-ai/sdk";
import {AI_ASSISTANT, ANTHROPIC} from "@coreModule/environment";
import type {serverLogger} from "@coreModule/loggers/serverLog";
import type {
    OllamaAssistantMessage,
    OllamaChatMessage,
    OllamaChatOptions,
    OllamaToolCall,
} from "@coreModule/domain/ai/ollamaClient";

/** Lazily constructed so importing this module never requires a configured key. */
let client: Anthropic | null = null;

function getClient(): Anthropic {
    if (!client) {
        client = new Anthropic({
            // Falls back to the SDK's own env resolution when unset.
            ...(ANTHROPIC.API_KEY ? {apiKey: ANTHROPIC.API_KEY} : {}),
            timeout: AI_ASSISTANT.TIMEOUT_MS,
        });
    }
    return client;
}

/**
 * Convert the brain's transcript into Claude's `system` + `messages` shape.
 *
 * Consecutive `tool` turns collapse into one user message of `tool_result`
 * blocks, which is what the API requires — splitting them across messages is
 * rejected, and it also trains the model out of parallel tool calls.
 */
function toAnthropicMessages(messages: OllamaChatMessage[]): {
    system: string;
    messages: Anthropic.MessageParam[];
} {
    const systemParts: string[] = [];
    const out: Anthropic.MessageParam[] = [];
    let pendingToolResults: Anthropic.ToolResultBlockParam[] = [];

    const flushToolResults = () => {
        if (pendingToolResults.length > 0) {
            out.push({role: "user", content: pendingToolResults});
            pendingToolResults = [];
        }
    };

    for (const message of messages) {
        if (message.role === "system") {
            flushToolResults();
            systemParts.push(message.content);
            continue;
        }

        if (message.role === "tool") {
            // Accumulate; emitted as one user message when the run ends.
            pendingToolResults.push({
                type: "tool_result",
                tool_use_id: message.tool_call_id ?? "",
                content: message.content,
            });
            continue;
        }

        flushToolResults();

        if (message.role === "user") {
            out.push({role: "user", content: message.content});
            continue;
        }

        // Assistant turn. Replay the original blocks when we have them — that
        // preserves thinking blocks and the exact tool_use ids the results
        // reference. Only reconstruct when this turn didn't come from us.
        if (message.raw) {
            out.push({role: "assistant", content: message.raw as Anthropic.ContentBlockParam[]});
            continue;
        }

        const blocks: Anthropic.ContentBlockParam[] = [];
        if (message.content) {
            blocks.push({type: "text", text: message.content});
        }
        for (const call of message.tool_calls ?? []) {
            blocks.push({
                type: "tool_use",
                id: call.id ?? "",
                name: call.function.name,
                input: call.function.arguments,
            });
        }
        if (blocks.length > 0) {
            out.push({role: "assistant", content: blocks});
        }
    }

    flushToolResults();
    return {system: systemParts.join("\n\n"), messages: out};
}

/**
 * Send a transcript to Claude and return one assistant message in the brain's
 * internal shape.
 *
 * @throws on transport failure, auth failure, or a refusal — the responder
 *         counts it and the Kafka consumer retries, same as the Ollama path.
 */
export async function anthropicChat(
    messages: OllamaChatMessage[],
    options: OllamaChatOptions = {},
): Promise<OllamaAssistantMessage> {
    const {tools, logger} = options;
    const model = options.model || ANTHROPIC.MODEL;
    const {system, messages: anthropicMessages} = toAnthropicMessages(messages);

    logger?.debug?.(
        `Claude chat → model=${model}, effort=${ANTHROPIC.EFFORT}` +
        `${tools?.length ? `, tools=${tools.length}` : ""}`,
    );

    const response = await getClient().messages.create({
        model,
        max_tokens: ANTHROPIC.MAX_TOKENS,
        // No temperature/top_p — the current Claude models reject sampling
        // parameters outright (400). Steer with the system prompt instead.
        thinking: {type: "adaptive"},
        output_config: {effort: ANTHROPIC.EFFORT},
        ...(system ? {system} : {}),
        ...(tools && tools.length > 0
            ? {
                tools: tools.map((tool) => ({
                    name: tool.function.name,
                    description: tool.function.description,
                    // Claude calls this `input_schema`; Ollama calls it `parameters`.
                    input_schema: tool.function.parameters as Anthropic.Tool.InputSchema,
                })),
            }
            : {}),
        messages: anthropicMessages,
    });

    // Safety classifiers can decline a request — a 200 with no usable content.
    // Surface it as an error so the responder's failure path handles it rather
    // than delivering an empty bubble to the visitor.
    if (response.stop_reason === "refusal") {
        throw new Error(
            `Claude declined the request (${response.stop_details?.category ?? "unspecified"})`,
        );
    }

    let text = "";
    const toolCalls: OllamaToolCall[] = [];
    for (const block of response.content) {
        if (block.type === "text") {
            text += block.text;
        }
        else if (block.type === "tool_use") {
            toolCalls.push({
                id: block.id,
                function: {
                    name: block.name,
                    arguments: (block.input ?? {}) as Record<string, unknown>,
                },
            });
        }
        // thinking / other block types are carried by `raw` below, not read here.
    }

    return {
        role: "assistant",
        content: text.trim(),
        ...(toolCalls.length > 0 ? {tool_calls: toolCalls} : {}),
        // Echoed verbatim on the next turn — see the translation notes above.
        raw: response.content as unknown,
    };
}
