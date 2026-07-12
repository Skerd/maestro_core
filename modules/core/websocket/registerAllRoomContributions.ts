/**
 * Discovers and registers websocket room display names from all enabled modules.
 *
 * Each module may expose rooms under `{module}/websocket/` by exporting a
 * function named like `register*RoomContribution(s)` that calls
 * {@link registerRoomDisplayNames}. Core stays decoupled: modules push rooms in.
 *
 * Mirrors {@link module:registerAllAssistantTools}.
 *
 * @module registerAllRoomContributions
 */

import path from "path";
import fs from "fs";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {isModuleEnabled} from "@coreModule/utilities/modules/enabledModules";
import {getRegisteredRoomCount} from "@coreModule/websocket/roomRegistry";

const REGISTER_FN_PATTERN = /^register.*RoomContributions?$/i;
const BOOTSTRAP_FILENAME = "registerAllRoomContributions.ts";

/** Only contribution entry files — not redisConnectionManager, webSocket, etc. */
function isRoomSourceFile(filename: string): boolean {
    return /roomContribution/i.test(filename)
        && filename.endsWith(".ts")
        && !filename.endsWith(".d.ts")
        && filename !== BOOTSTRAP_FILENAME;
}

function findRegisterFunctions(moduleExports: Record<string, unknown>): Array<{name: string; fn: () => void}> {
    const fns: Array<{name: string; fn: () => void}> = [];

    for (const [name, value] of Object.entries(moduleExports)) {
        if (name === "registerAllRoomContributions") {
            continue;
        }
        if (typeof value === "function" && REGISTER_FN_PATTERN.test(name)) {
            fns.push({name, fn: value as () => void});
        }
    }

    return fns;
}

/**
 * Scan all enabled modules and invoke every exported room-registration function
 * found under `{module}/websocket/`.
 */
export async function registerAllRoomContributions(parentLogger?: serverLogger): Promise<void> {
    const logger = getLogger("websocket_rooms", parentLogger);
    logger.start("Registering websocket room contributions...");

    // webSocket.ts lives in modules/core/websocket → modules root is ../../..
    const modulesPath = path.resolve(__dirname, "../../..");
    if (!fs.existsSync(modulesPath)) {
        logger.err(`Modules directory does not exist: ${modulesPath}`);
        logger.finish("Finished registering websocket room contributions!");
        return;
    }

    const moduleEntries = fs.readdirSync(modulesPath, {withFileTypes: true});
    const moduleDirs = moduleEntries.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."));

    for (const moduleEntry of moduleDirs) {
        if (!isModuleEnabled(moduleEntry.name)) {
            continue;
        }

        const websocketDir = path.join(modulesPath, moduleEntry.name, "websocket");
        let websocketStat: fs.Stats | undefined;
        try {
            websocketStat = fs.statSync(websocketDir);
        } catch {
            websocketStat = undefined;
        }

        if (!websocketStat?.isDirectory()) {
            continue;
        }

        logger.updateSpace(1);
        logger.debug(`Discovering room contributions for [${moduleEntry.name}/websocket]...`);

        const files = fs.readdirSync(websocketDir, {withFileTypes: true});
        for (const file of files) {
            if (!file.isFile() || !isRoomSourceFile(file.name)) {
                continue;
            }

            const filePath = path.join(websocketDir, file.name);
            const importPath = filePath.replace(/\.ts$/, "");

            try {
                const roomModule = await import(importPath);
                const registerFns = findRegisterFunctions(roomModule);

                if (registerFns.length === 0) {
                    continue;
                }

                for (const {name, fn} of registerFns) {
                    fn();
                    logger.debug(`Registered rooms via ${name} from ${filePath}`);
                }
            } catch (error: any) {
                logger.err(`Failed to load room contributions from ${filePath}`, error);
            }
        }

        logger.updateSpace(-1);
    }

    logger.finish(`Registered websocket rooms (${getRegisteredRoomCount()} total).`);
}
