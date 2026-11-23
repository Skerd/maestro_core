/**
 * The hooks a module may export from `{module}/database/moduleBootstrap` as `moduleBootstrap.<hook>`; core never imports
 * module code. `onModuleEnabled` gives a company that gets the module its starter records (TD-B254): whether the company
 * is created with the module (the panel's create, a self-serve sign-up) or the platform grants it later (Manage modules).
 * `onAccountVerified` gives an account with a verified email the guest records made with that email (P23.9).
 *
 * @module moduleCompanyDefaults
 */

import path from "path";
import fs from "fs";
import type {ClientSession} from "mongoose";
import type {ObjectId} from "mongodb";
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

/**
 * What a module's hook gets once an account's email is verified: a transaction of its own, opened after the sign-in's
 * or activation's has committed. Guest records live in many companies, so the hook works across them with
 * `asCrossTenant` and a reason (or one company's slice with `withTenant`), never in the caller's tenant.
 */
export type AccountVerifiedContext = {
    userId: ObjectId;
    /** The verified address, trimmed and lower-cased. */
    email: string;
    session: ClientSession;
    logger: serverLogger;
    languageCode: string;
};

/**
 * Gives the account the module's records a guest made with exactly this email and that no account holds yet; a record
 * tied to an account is never moved. It runs at every portal sign-in, so it must be cheap and change nothing the second time.
 */
export type AccountVerifiedHook = (context: AccountVerifiedContext) => Promise<void>;

/** The hooks a module's bootstrap may export. */
type ModuleBootstrapHooks = {onModuleEnabled?: ModuleEnabledHook; onAccountVerified?: AccountVerifiedHook};

type ModuleBootstrapExport = {moduleBootstrap?: ModuleBootstrapHooks};

const bootstraps = new Map<string, Promise<ModuleBootstrapHooks | undefined>>();

/** A module's hook of this name, or undefined when it exports none; each bootstrap file is loaded once. */
export async function moduleBootstrapHook<Name extends keyof ModuleBootstrapHooks>(
    moduleName: string,
    hookName: Name,
): Promise<ModuleBootstrapHooks[Name]> {
    let hooks = bootstraps.get(moduleName);
    if (!hooks) {
        const file = path.join(path.resolve(__dirname, "../../.."), moduleName, "database", moduleCodeFile("moduleBootstrap"));
        hooks = fs.existsSync(file)
            ? import(withoutModuleExtension(file)).then((loaded: ModuleBootstrapExport) => loaded.moduleBootstrap)
            : Promise.resolve(undefined);
        bootstraps.set(moduleName, hooks);
    }
    return (await hooks)?.[hookName];
}

/** Runs the starter-records hook of each of `moduleNames` that this server runs, in the company's tenant. */
export async function runModuleCompanyDefaults(company: ICompany, moduleNames: readonly string[], context: Omit<ModuleEnabledContext, "company">): Promise<void> {
    const enabled = new Set(getEnabledModuleNames());
    for (const moduleName of moduleNames) {
        if (moduleName === "core" || !enabled.has(moduleName)) continue;
        const hook = await moduleBootstrapHook(moduleName, "onModuleEnabled");
        if (hook) await withTenant(company._id, () => hook({...context, company}));
    }
}
