/**
 * Notification Handler Registry
 *
 * Discovers and registers notification event handlers from all modules.
 * Each module may export handler registration under `domain/notifications/`.
 */

import path from "path";
import fs from "fs";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {isModuleEnabled} from "@coreModule/utilities/modules/enabledModules";

const REGISTER_FN_PATTERN = /^register.*Notification.*Handlers?$/i;
const BOOTSTRAP_FILENAME = "registerAllNotificationHandlers.ts";

function isHandlerSourceFile(filename: string): boolean {
    return filename.endsWith(".ts") && !filename.endsWith(".d.ts") && filename !== BOOTSTRAP_FILENAME;
}

function findRegisterFunctions(moduleExports: Record<string, unknown>): Array<{name: string; fn: () => void}> {
    const fns: Array<{name: string; fn: () => void}> = [];

    for (const [name, value] of Object.entries(moduleExports)) {
        if (name === "registerAllNotificationHandlers") {
            continue;
        }
        if (typeof value === "function" && REGISTER_FN_PATTERN.test(name)) {
            fns.push({name, fn: value as () => void});
        }
    }

    return fns;
}

/**
 * Scan all modules and invoke every exported notification handler registration function
 * found under `{module}/domain/notifications/`.
 */
export async function registerAllNotificationHandlers(parentLogger?: serverLogger): Promise<void> {
    const logger = getLogger("notification_handlers", parentLogger);
    logger.start("Registering notification event handlers...");

    const modulesPath = path.resolve(__dirname, "../../..");
    if (!fs.existsSync(modulesPath)) {
        logger.err(`Modules directory does not exist: ${modulesPath}`);
        logger.finish("Finished registering notification event handlers!");
        return;
    }

    const moduleEntries = fs.readdirSync(modulesPath, {withFileTypes: true});
    const moduleDirs = moduleEntries.filter(entry => entry.isDirectory() && !entry.name.startsWith("."));
    let handlerCount = 0;

    for (const moduleEntry of moduleDirs) {
        if (!isModuleEnabled(moduleEntry.name)) {
            continue;
        }
        const notificationsDir = path.join(modulesPath, moduleEntry.name, "domain", "notifications");
        let notificationsStat: fs.Stats | undefined;

        try {
            notificationsStat = fs.statSync(notificationsDir);
        } catch {
            notificationsStat = undefined;
        }

        if (!notificationsStat?.isDirectory()) {
            continue;
        }

        logger.updateSpace(1);
        logger.debug(`Discovering notification handlers for [${moduleEntry.name}/domain/notifications]...`);

        const files = fs.readdirSync(notificationsDir, {withFileTypes: true});
        for (const file of files) {
            if (!file.isFile() || !isHandlerSourceFile(file.name)) {
                continue;
            }

            const filePath = path.join(notificationsDir, file.name);
            const importPath = filePath.replace(/\.ts$/, "");

            try {
                const handlerModule = await import(importPath);
                const registerFns = findRegisterFunctions(handlerModule);

                if (registerFns.length === 0) {
                    logger.debug(`Skipping ${filePath} — no notification register export.`);
                    continue;
                }

                for (const {name, fn} of registerFns) {
                    fn();
                    handlerCount += 1;
                    logger.debug(`Registered ${name} from ${filePath}`);
                }
            } catch (error: any) {
                logger.err(`Failed to load notification handlers from ${filePath}`, error);
            }
        }

        logger.updateSpace(-1);
    }

    logger.finish(`Registered ${handlerCount} notification handler group${handlerCount !== 1 ? "s" : ""}!`);
}
