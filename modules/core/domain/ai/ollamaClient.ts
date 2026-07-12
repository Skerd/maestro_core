/**
 * Ollama chat client — the thin HTTP wrapper the assistant brain uses to talk to
 * the local LLM. Speaks Ollama's `/api/chat` endpoint (non-streaming), including
 * tool-calling: pass `tools` and the model may respond with `tool_calls` instead
 * of (or before) a text answer.
 *
 * This is transport only: it builds the request, enforces the timeout, and
 * returns the assistant message. All prompt construction, tool dispatch, and
 * fallback policy live in {@link module:assistantBrain}. Errors propagate so the
 * responder can count the failure and let the Kafka consumer retry.
 *
 * @module ollamaClient
 */

import axios from "axios";
import {AI_ASSISTANT} from "@coreModule/environment";
import type {serverLogger} from "@coreModule/loggers/serverLog";

/** A single turn in the chat transcript sent to the model. */
export interface OllamaChatMessage {
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    /** Present on assistant turns that requested tools (echoed back on the next call). */
    tool_calls?: OllamaToolCall[];
}

/** A tool invocation the model asked for. `arguments` is already parsed by Ollama. */
export interface OllamaToolCall {
    id?: string;
    function: {
        name: string;
        arguments: Record<string, unknown>;
    };
}

/** A tool definition advertised to the model (OpenAI-style function schema). */
export interface OllamaTool {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: unknown;
    };
}

/** The assistant message returned by `/api/chat`. */
export interface OllamaAssistantMessage {
    role: "assistant";
    content: string;
    tool_calls?: OllamaToolCall[];
}

interface OllamaChatResponse {
    message?: OllamaAssistantMessage;
    done?: boolean;
}

export interface OllamaChatOptions {
    /** Tools to advertise for this call. Omit for a plain chat completion. */
    tools?: OllamaTool[];
    logger?: serverLogger;
}

/**
 * Send a chat transcript to the local Ollama server and return the assistant
 * message (which may carry `tool_calls` instead of text).
 *
 * @param messages - Ordered transcript (system first, then user/assistant/tool turns).
 * @param options - Optional tools + logger.
 * @returns The assistant message.
 * @throws If the server is unreachable, times out, or returns no message.
 */
export async function ollamaChat(
    messages: OllamaChatMessage[],
    options: OllamaChatOptions = {}
): Promise<OllamaAssistantMessage> {
    const {tools, logger} = options;
    const url = `${AI_ASSISTANT.BASE_URL.replace(/\/+$/, "")}/api/chat`;

    logger?.debug?.(
        `Ollama chat → ${url} (model=${AI_ASSISTANT.MODEL}${tools?.length ? `, tools=${tools.length}` : ""})`
    );

    const body: Record<string, unknown> = {
        model: AI_ASSISTANT.MODEL,
        messages,
        stream: false,
        options: {temperature: AI_ASSISTANT.TEMPERATURE}
    };
    if (tools && tools.length > 0) {
        body.tools = tools;
    }

    const response = await axios.post<OllamaChatResponse>(url, body, {
        timeout: AI_ASSISTANT.TIMEOUT_MS,
        headers: {"Content-Type": "application/json"}
    });

    const message = response.data?.message;
    if (!message) {
        throw new Error("Ollama returned no message");
    }

    return {
        role: "assistant",
        content: (message.content ?? "").trim(),
        tool_calls: message.tool_calls
    };
}
