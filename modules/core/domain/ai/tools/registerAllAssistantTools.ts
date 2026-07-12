/**
 * AI-assistant tool registry bootstrap.
 *
 * Discovers and registers assistant tools from all enabled modules. Each module
 * may expose tools under `{module}/domain/ai/tools/` by exporting a function
 * named like `register*AssistantTools` that calls
 * {@link registerAssistantTool}. This keeps core decoupled: modules push their
 * tools in; core never imports module code.
 *
 * Mirrors {@link module:registerAllNotificationHandlers}.
 *
 * @module registerAllAssistantTools
 */

import path from "path";
import fs from "fs";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {isModuleEnabled} from "@coreModule/utilities/modules/enabledModules";
import {getAssistantToolCount} from "@coreModule/domain/ai/tools/toolRegistry";

const REGISTER_FN_PATTERN = /^register.*AssistantTools?$/i;
const BOOTSTRAP_FILENAME = "registerAllAssistantTools.ts";

function isToolSourceFile(filename: string): boolean {
    return filename.endsWith(".ts") && !filename.endsWith(".d.ts") && filename !== BOOTSTRAP_FILENAME;
}

function findRegisterFunctions(moduleExports: Record<string, unknown>): Array<{name: string; fn: () => void}> {
    const fns: Array<{name: string; fn: () => void}> = [];

    for (const [name, value] of Object.entries(moduleExports)) {
        if (name === "registerAllAssistantTools") {
            continue;
        }
        if (typeof value === "function" && REGISTER_FN_PATTERN.test(name)) {
            fns.push({name, fn: value as () => void});
        }
    }

    return fns;
}

/**
 * Scan all enabled modules and invoke every exported tool-registration function
 * found under `{module}/domain/ai/tools/`.
 */
export async function registerAllAssistantTools(parentLogger?: serverLogger): Promise<void> {
    const logger = getLogger("assistant_tools", parentLogger);
    logger.start("Registering AI-assistant tools...");

    const modulesPath = path.resolve(__dirname, "../../../..");
    if (!fs.existsSync(modulesPath)) {
        logger.err(`Modules directory does not exist: ${modulesPath}`);
        logger.finish("Finished registering AI-assistant tools!");
        return;
    }

    const moduleEntries = fs.readdirSync(modulesPath, {withFileTypes: true});
    const moduleDirs = moduleEntries.filter(entry => entry.isDirectory() && !entry.name.startsWith("."));

    for (const moduleEntry of moduleDirs) {
        if (!isModuleEnabled(moduleEntry.name)) {
            continue;
        }
        const toolsDir = path.join(modulesPath, moduleEntry.name, "domain", "ai", "tools");
        let toolsStat: fs.Stats | undefined;

        try {
            toolsStat = fs.statSync(toolsDir);
        } catch {
            toolsStat = undefined;
        }

        if (!toolsStat?.isDirectory()) {
            continue;
        }

        logger.updateSpace(1);
        logger.debug(`Discovering assistant tools for [${moduleEntry.name}/domain/ai/tools]...`);

        const files = fs.readdirSync(toolsDir, {withFileTypes: true});
        for (const file of files) {
            if (!file.isFile() || !isToolSourceFile(file.name)) {
                continue;
            }

            const filePath = path.join(toolsDir, file.name);
            const importPath = filePath.replace(/\.ts$/, "");

            try {
                const toolModule = await import(importPath);
                const registerFns = findRegisterFunctions(toolModule);

                if (registerFns.length === 0) {
                    continue;
                }

                for (const {name, fn} of registerFns) {
                    fn();
                    logger.debug(`Registered assistant tools via ${name} from ${filePath}`);
                }
            } catch (error: any) {
                logger.err(`Failed to load assistant tools from ${filePath}`, error);
            }
        }

        logger.updateSpace(-1);
    }

    logger.finish(`Registered AI-assistant tools (${getAssistantToolCount()} total).`);
}
