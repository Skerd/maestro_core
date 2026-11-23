/**
 * A module's starter records for a company that gets it (TD-B254): whether the company is created with the module (the
 * panel's create, a self-serve sign-up) or the platform grants it later (Manage modules). Each module may export
 * `moduleBootstrap.onModuleEnabled` from `{module}/database/moduleBootstrap`; core never imports module code.
 *
 * @module moduleCompanyDefaults
 */

import path from "path";
import fs from "fs";
import type {ClientSession} from "mongoose";
import type {ICompany} from "@coreModule/database/schemas/company/company";
import type {serverLogger} from "@coreModule/loggers/serverLog";
import {withTenant} from "@coreModule/utilities/endpoints/tenantScope";
import {getEnabledModuleNames} from "@coreModule/utilities/modules/enabledModules";
import {moduleCodeFile, withoutModuleExtension} from "@coreModule/utilities/modules/moduleCodeFiles";

/** What a module's hook gets: the company, inside its own tenant and the caller's transaction. */
export type ModuleEnabledContext = {
    company: ICompany;
    session: ClientSession;
    logger: serverLogger;
    /** The language of the request that gave the company the module: starter names are written in it. */
    languageCode: string;
};

/** A module's starter records for a company; it must add only what is missing, since it may run again. */
export type ModuleEnabledHook = (context: ModuleEnabledContext) => Promise<void>;

type ModuleBootstrapExport = {moduleBootstrap?: {onModuleEnabled?: ModuleEnabledHook}};

const hooks = new Map<string, Promise<ModuleEnabledHook | undefined>>();

function hookOf(moduleName: string): Promise<ModuleEnabledHook | undefined> {
    let hook = hooks.get(moduleName);
    if (!hook) {
        const file = path.join(path.resolve(__dirname, "../../.."), moduleName, "database", moduleCodeFile("moduleBootstrap"));
        hook = fs.existsSync(file)
            ? import(withoutModuleExtension(file)).then((loaded: ModuleBootstrapExport) => loaded.moduleBootstrap?.onModuleEnabled)
            : Promise.resolve(undefined);
        hooks.set(moduleName, hook);
    }
    return hook;
}

/** Runs the starter-records hook of each of `moduleNames` that this server runs, in the company's tenant. */
export async function runModuleCompanyDefaults(company: ICompany, moduleNames: readonly string[], context: Omit<ModuleEnabledContext, "company">): Promise<void> {
    const enabled = new Set(getEnabledModuleNames());
    for (const moduleName of moduleNames) {
        if (moduleName === "core" || !enabled.has(moduleName)) continue;
        const hook = await hookOf(moduleName);
        if (hook) await withTenant(company._id, () => hook({...context, company}));
    }
}
