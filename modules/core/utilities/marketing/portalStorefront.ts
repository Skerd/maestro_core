import type {ICompany} from "@coreModule/database/schemas/company/company";
import {resolveCompanyByOrigin, resolveSignupCompany} from "@coreModule/utilities/marketing/resolveCompanyByOrigin";
import {isPortalApexOrigin, isPortalZoneOrigin} from "@coreModule/utilities/marketing/portalOrigin";
import {allowForeignReferences, asCrossTenant, setRequestTenant} from "@coreModule/utilities/endpoints/tenantScope";
import type {ForeignReferenceAllowance} from "@coreModule/database/plugins/tenantReferences";

/** A storefront request on one company's own site: every read and write stays in that company. */
export type StorefrontTenantContext = {
    mode: "tenant";
    company: ICompany;
};

/** A storefront request on the portal apex: catalogs span every listed seller. */
export type StorefrontPlatformContext = {
    mode: "platform";
    /** The session / sign-up company, for the buyer's own records (cart, orders, account) on the apex. */
    sessionCompany: ICompany;
};

export type StorefrontContext = StorefrontTenantContext | StorefrontPlatformContext;

/**
 * Public storefront tenancy, shared by every module that sells on the portal (products, services): the portal apex is
 * the platform (all listed sellers); a company's site in the portal zone, or any other host, resolves to one company
 * through `resolveCompanyByOrigin`, which also sets the request tenant.
 */
export async function resolveStorefrontContext(origin: string, languageCode: string): Promise<StorefrontContext> {
    if (isPortalApexOrigin(origin)) {
        const sessionCompany = await resolveSignupCompany(origin, languageCode);
        // The apex works on the platform's own data (config, reference lists, accounts); catalog
        // views that span sellers say so through `inStorefrontCatalog` (D16).
        setRequestTenant(sessionCompany._id, languageCode);
        return {mode: "platform", sessionCompany};
    }
    const company = await resolveCompanyByOrigin(origin, languageCode);
    return {mode: "tenant", company};
}

/**
 * Runs a read-only catalog view (D16): across every listed seller on the portal apex, and inside the one company on
 * its own site, whose tenant `resolveStorefrontContext` already set.
 */
export function inStorefrontCatalog<T>(ctx: StorefrontContext, view: () => Promise<T>): Promise<T> {
    return ctx.mode === "platform" ? asCrossTenant("the portal apex lists every seller's catalog", view) : view();
}

/** A purchase request comes from the portal zone (apex or a company's portal site), so it may span sellers. */
export function isPortalPurchase(origin: string | undefined): boolean {
    return isPortalZoneOrigin(origin ?? "");
}

/**
 * Runs a purchase's seller work on the portal (D16): a purchase made in the portal zone buys from every listed seller,
 * so its reads and writes span their companies and each write names its seller's `company` itself. Any other purchase
 * runs in its own company's tenant, unchanged. `allowance` lists the references the caller's records store across
 * companies (D104), e.g. a platform cart naming each seller's products; without one, every reference must still point
 * inside its record's company.
 */
export function inPortalPurchase<T>(spansSellers: boolean, work: () => Promise<T>, allowance?: ForeignReferenceAllowance): Promise<T> {
    if (!spansSellers) return work();
    const reason = "a portal purchase buys from every listed seller";
    return asCrossTenant(reason, allowance ? () => allowForeignReferences(allowance, work) : work);
}

/** A route handler whose work runs through `inPortalPurchase` when its request is a portal purchase. */
export function portalPurchaseRoute<P extends {origin?: string}, Q, R>(handler: (params: P, query: Q) => Promise<R>, allowance?: ForeignReferenceAllowance) {
    return (params: P, query: Q): Promise<R> => inPortalPurchase(isPortalPurchase(params.origin), () => handler(params, query), allowance);
}
