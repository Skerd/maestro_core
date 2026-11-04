import type {Types} from "mongoose";
import {requestContext} from "@coreModule/utilities/endpoints/requestContext";

/**
 * Tenant scoping (D16, DB-02). Every query on a model with `ownershipPlugin` is limited to the current
 * request's or job's company, and work with no company and no opt-out is refused (fail closed). These
 * helpers set that company, or mark a block as deliberately reaching every company's data.
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
 * `module` names the module the work belongs to, for the refusal log.
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
