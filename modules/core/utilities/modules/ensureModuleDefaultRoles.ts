/**
 * Discovers `{module}/database/moduleBootstrap.ts` defaultRoles packs and
 * registers them without core importing feature modules.
 */

import path from "path";
import fs from "fs";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {getEnabledModuleNames} from "@coreModule/utilities/modules/enabledModules";
import {moduleCodeFile, withoutModuleExtension} from "@coreModule/utilities/modules/moduleCodeFiles";
import {
    registerDefaultRoles,
    type DefaultRoleDefinition,
} from "@coreModule/database/schemas/role/role.defaults";

type ModuleBootstrapExport = {
    moduleBootstrap?: {
        defaultRoles?: DefaultRoleDefinition[];
    };
};

let loaded = false;

export async function ensureModuleDefaultRolesRegistered(parentLogger?: serverLogger): Promise<void> {
    if (loaded) {
        return;
    }
    loaded = true;

    const logger = getLogger("module_default_roles", parentLogger);
    const modulesRoot = path.resolve(__dirname, "../../..");

    for (const moduleName of getEnabledModuleNames()) {
        if (moduleName === "core") {
            continue;
        }

        const bootstrapFile = path.join(modulesRoot, moduleName, "database", moduleCodeFile("moduleBootstrap"));
        if (!fs.existsSync(bootstrapFile)) {
            continue;
        }

        const importPath = withoutModuleExtension(bootstrapFile);
        try {
            const mod = (await import(importPath)) as ModuleBootstrapExport;
            const pack = mod.moduleBootstrap?.defaultRoles;
            if (!Array.isArray(pack) || pack.length === 0) {
                continue;
            }
            registerDefaultRoles(pack, moduleName);
            logger.debug(`Registered ${pack.length} default role(s) from [${moduleName}]`);
        } catch (error: any) {
            logger.err(`Failed to load default roles from ${bootstrapFile}`, error);
        }
    }
}
