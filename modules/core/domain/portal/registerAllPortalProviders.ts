/**
 * Portal section bootstrap.
 *
 * Discovers and registers portal sections from all enabled modules. Each module may
 * expose its section under `{module}/domain/portal/` by exporting a function named
 * like `register*PortalProvider` that calls {@link registerPortalProvider}. Core never
 * imports module code.
 *
 * Mirrors {@link module:registerAllAssistantTools}.
 *
 * @module registerAllPortalProviders
 */

import path from "path";
import fs from "fs";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {isModuleEnabled} from "@coreModule/utilities/modules/enabledModules";
import {isModuleCodeFile, moduleCodeFile, withoutModuleExtension} from "@coreModule/utilities/modules/moduleCodeFiles";
import {listPortalProviders} from "@coreModule/domain/portal/portalProviderRegistry";

const REGISTER_FN_PATTERN = /^register.*PortalProviders?$/i;
const BOOTSTRAP_FILENAME = moduleCodeFile("registerAllPortalProviders");

/** Exports matching {@link REGISTER_FN_PATTERN} that are not entry points. */
const NON_ENTRYPOINT_EXPORTS = new Set(["registerAllPortalProviders", "registerPortalProvider"]);

function isProviderSourceFile(filename: string): boolean {
    return isModuleCodeFile(filename) && filename !== BOOTSTRAP_FILENAME;
}

function findRegisterFunctions(moduleExports: Record<string, unknown>): Array<{name: string; fn: () => void}> {
    const fns: Array<{name: string; fn: () => void}> = [];

    for (const [name, value] of Object.entries(moduleExports)) {
        if (NON_ENTRYPOINT_EXPORTS.has(name)) {
            continue;
        }
        if (typeof value === "function" && REGISTER_FN_PATTERN.test(name)) {
            fns.push({name, fn: value as () => void});
        }
    }

    return fns;
}

/**
 * Scan all enabled modules and invoke every exported provider-registration function
 * found under `{module}/domain/portal/`.
 */
export async function registerAllPortalProviders(parentLogger?: serverLogger): Promise<void> {
    const logger = getLogger("portal_providers", parentLogger);
    logger.start("Registering portal sections...");

    const modulesPath = path.resolve(__dirname, "../../..");
    if (!fs.existsSync(modulesPath)) {
        logger.err(`Modules directory does not exist: ${modulesPath}`);
        logger.finish("Finished registering portal sections!");
        return;
    }

    const moduleDirs = fs.readdirSync(modulesPath, {withFileTypes: true})
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."));

    for (const moduleEntry of moduleDirs) {
        if (!isModuleEnabled(moduleEntry.name)) {
            continue;
        }
        const portalDir = path.join(modulesPath, moduleEntry.name, "domain", "portal");
        if (!fs.existsSync(portalDir) || !fs.statSync(portalDir).isDirectory()) {
            continue;
        }

        for (const file of fs.readdirSync(portalDir, {withFileTypes: true})) {
            if (!file.isFile() || !isProviderSourceFile(file.name)) {
                continue;
            }
            const filePath = path.join(portalDir, file.name);
            try {
                const providerModule = await import(withoutModuleExtension(filePath));
                for (const {name, fn} of findRegisterFunctions(providerModule)) {
                    fn();
                    logger.debug(`Registered portal section via ${name} from ${filePath}`);
                }
            } catch (error: any) {
                logger.err(`Failed to load portal section from ${filePath}`, error);
            }
        }
    }

    logger.finish(`Registered portal sections: ${listPortalProviders().map((provider) => provider.key).join(", ") || "(none)"}.`);
}
