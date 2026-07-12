/**
 * AI-assistant tool-calling types.
 *
 * A tool is the seam through which the assistant reaches real application data.
 * The LLM is shown each tool's {@link AssistantTool.parameters} (a JSON Schema)
 * and, when it decides to call one, the brain dispatches to
 * {@link AssistantTool.execute} with the arguments the model produced.
 *
 * SECURITY: `execute` MUST treat its arguments as untrusted model output.
 * Re-validate them (e.g. with Zod) and scope every data access to the calling
 * human's company via {@link AssistantToolContext.companyId} — never widen scope
 * based on anything the model said. The bot has no authority of its own.
 *
 * @module assistantTool.types
 */

import type {serverLogger} from "@coreModule/loggers/serverLog";

/** Minimal JSON Schema (object) describing a tool's arguments for the LLM. */
export interface AssistantToolParameters {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
}

/** The trusted, server-side context a tool executes within. */
export interface AssistantToolContext {
    /** Company scope of the conversation — the ONLY scope a tool may read. */
    companyId: string;
    /** The human user the assistant is answering (for auditing/ownership). */
    userId: string;
    /** Language for any localized lookups/among results. */
    languageCode?: string;
    /** Logger for tracing tool execution. */
    logger?: serverLogger;
}

/**
 * A callable tool exposed to the assistant. Modules register tools into the
 * shared registry; the brain (core) never imports module code directly.
 */
export interface AssistantTool {
    /** Unique function name the model calls (snake_case, e.g. `search_properties`). */
    name: string;
    /** Natural-language description the model uses to decide when to call it. */
    description: string;
    /** JSON Schema of the arguments, shown to the model. */
    parameters: AssistantToolParameters;
    /**
     * Execute the tool. `rawArgs` is untrusted model output — validate it.
     * Return any JSON-serializable value; the brain stringifies it back to the
     * model as the tool result. Throwing is allowed; the brain reports the
     * failure back to the model as a tool error rather than crashing the turn.
     */
    execute(rawArgs: unknown, ctx: AssistantToolContext): Promise<unknown>;
}
