/**
 * Cron Handler Bootstrap
 *
 * Discovers and registers cron handlers from all modules.
 * Scans `{module}/utilities/cron/`.
 */

import path from "path";
import fs from "fs";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {isModuleEnabled} from "@coreModule/utilities/modules/enabledModules";

const REGISTER_FN_PATTERN = /^register.*CronHandlers?$/i;
const CRON_HANDLER_DIR = "utilities/cron";

type CronHandlerRegistrar = () => void;

function isHandlerSourceFile(filename: string): boolean {
    return filename.endsWith(".ts") && !filename.endsWith(".d.ts");
}

function findRegisterFunctions(moduleExports: Record<string, unknown>): Array<{name: string; fn: CronHandlerRegistrar}> {
    const fns: Array<{name: string; fn: CronHandlerRegistrar}> = [];

    for (const [name, value] of Object.entries(moduleExports)) {
        if (typeof value === "function" && REGISTER_FN_PATTERN.test(name)) {
            fns.push({name, fn: value as CronHandlerRegistrar});
        }
    }

    return fns;
}

/**
 * Scan all enabled modules and invoke every exported cron handler registration
 * function found in `{module}/utilities/cron/`.
 */
export async function loadAllCronHandlers(parentLogger?: serverLogger): Promise<void> {
    const logger = getLogger("cron_handlers", parentLogger);
    logger.start("Loading cron handler registrations...");

    const modulesPath = path.resolve(__dirname, "../../..");
    if (!fs.existsSync(modulesPath)) {
        logger.err(`Modules directory does not exist: ${modulesPath}`);
        logger.finish("Finished loading cron handler registrations!");
        return;
    }

    const moduleEntries = fs.readdirSync(modulesPath, {withFileTypes: true});
    const moduleDirs = moduleEntries.filter(entry => entry.isDirectory() && !entry.name.startsWith("."));
    let handlerCount = 0;

    for (const moduleEntry of moduleDirs) {
        if (!isModuleEnabled(moduleEntry.name)) {
            continue;
        }
        const cronDir = path.join(modulesPath, moduleEntry.name, ...CRON_HANDLER_DIR.split("/"));
        if (!fs.existsSync(cronDir) || !fs.statSync(cronDir).isDirectory()) {
            continue;
        }

        logger.updateSpace(1);
        logger.debug(`Discovering cron handlers for [${moduleEntry.name}/${CRON_HANDLER_DIR}]...`);

        const files = fs.readdirSync(cronDir, {withFileTypes: true});
        for (const file of files) {
            if (!file.isFile() || !isHandlerSourceFile(file.name)) {
                continue;
            }

            const filePath = path.join(cronDir, file.name);
            const importPath = filePath.replace(/\.ts$/, "");

            try {
                const handlerModule = await import(importPath);
                const registerFns = findRegisterFunctions(handlerModule);

                if (registerFns.length === 0) {
                    logger.debug(`Skipping ${filePath} — no cron register export.`);
                    continue;
                }

                for (const {name, fn} of registerFns) {
                    fn();
                    handlerCount += 1;
                    logger.debug(`Registered ${name} from ${filePath}`);
                }
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                logger.err(`Failed to load cron handlers from ${filePath}: ${message}`);
            }
        }

        logger.updateSpace(-1);
    }

    logger.finish(`Loaded ${handlerCount} cron handler registration group${handlerCount !== 1 ? "s" : ""}!`);
}
