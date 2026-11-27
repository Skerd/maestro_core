/**
 * Which module owns each Mongoose model, used to hide a disabled module's models and
 * permissions per company.
 *
 * `loadOptionalModuleBootstraps()` registers each module's `moduleBootstrap.models`. Those
 * lists are not complete (many models load through route imports), so a model missing
 * from them is looked up by the file that defined it: every model lives under
 * `modules/<module>/database/`, and its file is in the require cache once it has loaded.
 */

import type {Model} from "mongoose";
import {isPlatformCollection} from "@coreModule/utilities/security/platformListRegistry";

const moduleByModel = new Map<string, string>();

const MODEL_FILE_PATTERN = /[\\/]modules[\\/]([^\\/]+)[\\/]database[\\/]/;

export function registerModelModules(moduleName: string, models: Model<any>[]): void {
    for (const model of models) {
        moduleByModel.set(model.modelName, moduleName);
    }
}

function isModel(value: unknown): value is Model<any> {
    return typeof value === "function" && typeof (value as {modelName?: unknown}).modelName === "string"
        && "schema" in (value as object);
}

/** Maps every loaded model file to its module. Bootstrap registrations win. */
function registerLoadedModelFiles(): void {
    for (const [file, loaded] of Object.entries(require.cache)) {
        const moduleName = MODEL_FILE_PATTERN.exec(file)?.[1];
        const model = (loaded?.exports as {default?: unknown} | undefined)?.default;
        if (moduleName && isModel(model) && !moduleByModel.has(model.modelName)) {
            moduleByModel.set(model.modelName, moduleName);
        }
    }
}

export function getModelModule(modelName: string): string {
    if (!moduleByModel.has(modelName)) {
        registerLoadedModelFiles();
    }
    return moduleByModel.get(modelName) ?? "core";
}

export function isModelInModules(modelName: string, modules: readonly string[]): boolean {
    const moduleName = getModelModule(modelName);
    return moduleName === "core" || modules.includes(moduleName);
}

/**
 * Whether a company sees a model (its access, table and view configs, audit log): a core model, a model of one of its
 * modules, or, for the platform company, a platform collection of any module (D195, D197). The platform company's flag is read
 * here, not through `isPlatformCompany`, which lives with the company service.
 */
export function isModelForCompany(
    model: {modelName: string; collection: {name: string}},
    modules: readonly string[],
    company: {isPlatformOwner?: boolean} | null | undefined,
): boolean {
    return isModelInModules(model.modelName, modules) || (company?.isPlatformOwner === true && isPlatformCollection(model.collection.name));
}

/**
 * Studio's catalog asks for every module installed on this server, not the grant on
 * `Company.modules`. Honored only in development: the same query in production stays
 * on the company filter.
 */
export function wantsInstalledModuleScope(query: {scope?: unknown} | undefined): boolean {
    return process.env.SERVER_NODE_ENV === "development" && query?.scope === "installed";
}

/** Sent only by Studio's sample-row preview. Ignored outside development. */
export const STUDIO_SAMPLE_HEADER = "x-studio-sample";

export function wantsStudioSample(header: unknown): boolean {
    return process.env.SERVER_NODE_ENV === "development" && header === "1";
}
