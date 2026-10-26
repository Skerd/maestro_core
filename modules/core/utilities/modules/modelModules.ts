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
