import type {Model, Schema} from "mongoose";

/** A module whose companies may keep their own rows of a platform-only model (e.g. mail servers for its campaigns). */
export type PlatformOnlyUse = {
    /** The platform-only model, by its Mongoose model name (`SmtpServer`). */
    model: string;
    /** The module, by its folder name; a company that has it may use the model. */
    module: string;
};

const modulesByModel = new Map<string, Set<string>>();

/**
 * Lets a module's companies keep their own rows of a platform-only model. Core never names a module (CORE-01): a module
 * declares the models in its `moduleBootstrap.platformOnlyUses`, and the bootstrap loader registers them under the
 * module's folder name, only for enabled modules.
 */
export function registerPlatformOnlyUse(use: PlatformOnlyUse): void {
    const modules = modulesByModel.get(use.model) ?? new Set<string>();
    modules.add(use.module);
    modulesByModel.set(use.model, modules);
}

/**
 * Makes a model the platform company's (D161): its rows stay stored per company, but only a session in the platform
 * company, or in a company that has a module registered for it (`registerPlatformOnlyUse`), may see or manage them.
 * Everyone else gets no access in the access map (so the panel hides the page and its menu entry) and a refusal from
 * every route `createCrudRouter` builds for the model, its actions included (`platform_company_required`). What the
 * platform's rows are used for, on behalf of every company (mail servers, messaging providers), is up to the model's
 * services.
 */
export const platformOnlyPlugin = (schema: Schema): void => {
    schema.set("platformOnly", true);
};

/** Whether `model` applies platformOnlyPlugin. */
export function isPlatformOnly(model: Model<any>): boolean {
    return model.schema.get("platformOnly") === true;
}

/** Whether a company (holding `modules`) may see and manage a platform-only `model`; true for any other model. */
export function mayUsePlatformOnly(
    model: Model<any>,
    company: {isPlatformOwner?: boolean} | null | undefined,
    modules: string[] | undefined,
): boolean {
    if (!isPlatformOnly(model)) return true;
    // `isPlatformCompany` lives with the company service, which schemas must not import (cycle).
    if (company?.isPlatformOwner === true) return true;
    const allowed = modulesByModel.get(model.modelName);
    return !!allowed && (modules ?? []).some((module) => allowed.has(module));
}

/**
 * A model's access as the access map reports it (`/api/user/permissions/access*`): a platform-only model is not there at
 * all for a company that may not use it, so the panel shows neither its page nor its menu entry.
 */
export function platformOnlyAccess<A extends {read: unknown; write: unknown; create: boolean; delete: boolean; restore: boolean}>(
    model: Model<any>,
    access: A,
    company: {isPlatformOwner?: boolean} | null | undefined,
    modules: string[] | undefined,
): A {
    if (mayUsePlatformOnly(model, company, modules)) return access;
    return {...access, read: false, write: false, create: false, delete: false, restore: false};
}

export default platformOnlyPlugin;
