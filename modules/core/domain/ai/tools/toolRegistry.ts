/**
 * AI-assistant tool registry.
 *
 * A process-wide map of tools the assistant may call. Modules register their
 * tools at startup (see {@link module:registerAllAssistantTools}); the brain
 * reads them at reply time. Keeping this in core lets the brain stay free of any
 * module dependency — tools flow in, not out.
 *
 * @module toolRegistry
 */

import type {
    AssistantAudience,
    AssistantReplyAudience,
    AssistantTool,
} from "@coreModule/domain/ai/tools/assistantTool.types";

const registry = new Map<string, AssistantTool>();
/** Owning module per tool name, stamped by registerAllAssistantTools. Unstamped = core. */
const moduleByTool = new Map<string, string>();

/**
 * A tool's effective audience. Fail closed: anything that did not explicitly
 * declare itself is internal-only, so forgetting the field can never leak a tool
 * to the public website.
 */
export function toolAudience(tool: AssistantTool): AssistantAudience {
    return tool.audience ?? "internal";
}

/** Whether a tool may be offered to / called by the given audience. */
export function isToolAllowedFor(tool: AssistantTool, audience: AssistantReplyAudience): boolean {
    const declared = toolAudience(tool);
    return declared === "both" || declared === audience;
}

/** Whether a company with `modules` gets this tool. */
function isToolInModules(tool: AssistantTool, modules: readonly string[]): boolean {
    const moduleName = moduleByTool.get(tool.name);
    return !moduleName || moduleName === "core" || modules.includes(moduleName);
}

/**
 * Register a tool. Last registration wins for a given name; a warning-worthy
 * collision is left to the caller's logging since registration happens at boot.
 */
export function registerAssistantTool(tool: AssistantTool): void {
    registry.set(tool.name, tool);
}

/**
 * Look up a tool by the name the model called, enforcing the audience.
 *
 * The audience argument is required precisely so that a caller cannot resolve a
 * tool without stating who it is for — that is the check that stops a model from
 * naming an internal tool it was never offered.
 */
export function getAssistantTool(
    name: string,
    audience: AssistantReplyAudience,
    modules: readonly string[],
): AssistantTool | undefined {
    const tool = registry.get(name);
    if (!tool || !isToolAllowedFor(tool, audience) || !isToolInModules(tool, modules)) {
        return undefined;
    }
    return tool;
}

/** Tools available to the given audience of a company with `modules`, in registration order. */
export function getAssistantTools(audience: AssistantReplyAudience, modules: readonly string[]): AssistantTool[] {
    return [...registry.values()].filter((tool) => isToolAllowedFor(tool, audience) && isToolInModules(tool, modules));
}

export function listAssistantToolNames(): string[] {
    return [...registry.keys()];
}

export function setAssistantToolModule(name: string, moduleName: string): void {
    moduleByTool.set(name, moduleName);
}

/** Number of registered tools. */
export function getAssistantToolCount(): number {
    return registry.size;
}

/** Clear the registry (tests only). */
export function clearAssistantTools(): void {
    registry.clear();
    moduleByTool.clear();
}
