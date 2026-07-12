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

import type {AssistantTool} from "@coreModule/domain/ai/tools/assistantTool.types";

const registry = new Map<string, AssistantTool>();

/**
 * Register a tool. Last registration wins for a given name; a warning-worthy
 * collision is left to the caller's logging since registration happens at boot.
 */
export function registerAssistantTool(tool: AssistantTool): void {
    registry.set(tool.name, tool);
}

/** Look up a tool by the name the model called. */
export function getAssistantTool(name: string): AssistantTool | undefined {
    return registry.get(name);
}

/** All registered tools, in registration order. */
export function getAssistantTools(): AssistantTool[] {
    return [...registry.values()];
}

/** Number of registered tools. */
export function getAssistantToolCount(): number {
    return registry.size;
}

/** Clear the registry (tests only). */
export function clearAssistantTools(): void {
    registry.clear();
}
