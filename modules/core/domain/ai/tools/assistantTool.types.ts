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

/**
 * Who a tool may be exposed to.
 *
 * - `internal` — company-role users only (the in-app assistant channel).
 * - `public`   — anonymous website visitors only.
 * - `both`     — safe for either.
 *
 * There is no default of convenience here: a tool that does not declare an
 * audience is treated as `internal` (see {@link toolAudience}). New tools are
 * private until someone deliberately opens them up, which is the correct
 * failure direction for a registry that reaches real CRM data.
 */
export type AssistantAudience = "internal" | "public" | "both";

/** Audience a reply is being generated for. `both` is not a caller-side value. */
export type AssistantReplyAudience = Exclude<AssistantAudience, "both">;

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
    /**
     * The conversation the tool call belongs to. Needed by tools that act on the
     * conversation itself (escalating to a human, attaching a captured lead)
     * rather than merely reading data.
     */
    channelId: string;
    /**
     * Who is on the other end. A tool that serves both audiences MUST narrow its
     * output for `public` — an anonymous visitor sees only what the marketing
     * site would already show them.
     */
    audience: AssistantReplyAudience;
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
    /**
     * Who this tool may be offered to. OMITTING THIS MEANS `internal` — do not
     * add `public` without checking every field the tool can return.
     */
    audience?: AssistantAudience;
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
