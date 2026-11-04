import type {Types} from "mongoose";
import {requestContext} from "@coreModule/utilities/endpoints/requestContext";

/**
 * Tenant scoping (D16, DB-02). Every query on a model with `ownershipPlugin` is limited to the current
 * request's or job's company. These helpers set that company, or mark a block as deliberately reaching
 * every company's data.
 *
 * Rollout: `TENANT_SCOPE_ENFORCE` lists the modules whose routes and cron handlers are enforced
 * (comma-separated, `*` = everything). Everywhere else the plugin only logs what it would have scoped
 * or refused, so the remaining entry points and opt-outs can be found before enforcement spreads.
 */

type CompanyId = Types.ObjectId | string;

/**
 * Records the tenant for the rest of the current request. It writes into the request's own context
 * (each request gets a fresh one from the route registry), so code that already runs inside the request,
 * like the handler after `resolveCompanyByOrigin`, sees it without being wrapped.
 */
export function setRequestTenant(companyId: CompanyId, languageCode?: string): void {
    const store = requestContext.getStore();
    if (!store) return;
    store.tenantCompanyId = String(companyId);
    if (languageCode) store.languageCode = languageCode;
}

/**
 * Runs `fn` as work for `companyId`: a cron job's run, or one company's slice of a cross-company read.
 * `module` names the module the work belongs to (decides enforcement during the rollout).
 */
export function withTenant<T>(companyId: CompanyId, fn: () => PromiseLike<T> | T, module?: string): Promise<T> {
    const store = {
        ...requestContext.getStore(),
        tenantCompanyId: String(companyId),
        crossTenantReason: undefined,
        ...(module ? {routeModule: module} : {}),
    };
    // Awaited inside the context: a Mongoose query only executes when awaited.
    return requestContext.run(store, async () => await fn());
}

/**
 * Runs `fn` without tenant scoping. Only for reads or writes that must span companies: platform-owner
 * screens, a portal customer's own records across shops, all-company sweeps. `reason` says which.
 */
export function asCrossTenant<T>(reason: string, fn: () => PromiseLike<T> | T): Promise<T> {
    return requestContext.run({...requestContext.getStore(), crossTenantReason: reason}, async () => await fn());
}

let enforcedRaw: string | undefined;
let enforcedModules: ReadonlySet<string> = new Set();

/**
 * Whether scoping is enforced for work of `module` (D16 rollout). Read on every call so tests can switch
 * it; `ENABLED_MODULES` is read the same way in `enabledModules.ts`.
 */
export function tenantScopeEnforced(module: string | undefined): boolean {
    const raw = process.env.TENANT_SCOPE_ENFORCE?.trim() ?? "";
    if (raw !== enforcedRaw) {
        enforcedRaw = raw;
        enforcedModules = new Set(raw.split(",").map((name) => name.trim()).filter(Boolean));
    }
    if (enforcedModules.has("*")) return true;
    return module !== undefined && enforcedModules.has(module);
}
