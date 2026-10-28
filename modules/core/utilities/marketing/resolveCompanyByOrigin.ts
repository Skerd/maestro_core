/**
 * Tenant resolution for unauthenticated (public-site) requests.
 *
 * A public visitor carries no token and therefore no company context, so the
 * tenant is derived from the request origin — the domain the public site is
 * served from, matched against `company.allowedDomains`.
 *
 * This lives in core because more than one module needs it: propertyManagement's
 * marketing endpoints and the core public chat both resolve their tenant this
 * way, and core must never import module code.
 *
 * @module resolveCompanyByOrigin
 */

import type {ClientSession} from "mongoose";
import {ICompany} from "@coreModule/database/schemas/company/company";
import {companyService} from "@coreModule/database/schemas/company/company.service";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import type {serverLogger} from "@coreModule/loggers/serverLog";
import {requestContext} from "@coreModule/utilities/endpoints/requestContext";
import {assertModuleEnabledForCompany} from "@coreModule/utilities/modules/companyModules";
import {isPortalApexOrigin, isPortalZoneOrigin, portalSiteSlug} from "@coreModule/utilities/marketing/portalOrigin";
import {findPlatformCompany, findPortalSiteCompany} from "@coreModule/utilities/marketing/portalCompanies";

/**
 * Resolve the tenant company from a public request's origin.
 *
 * Falls back to an active company whose `allowedDomains` contains `"*"` (the
 * platform owner first), which is what makes local development (localhost,
 * preview hosts) work without per-environment domain configuration.
 *
 * The company must have the module whose router is handling the request, so a
 * module's public site stops answering for a company that lost the module.
 *
 * In the portal zone a company site names its company in the host (`{siteSlug}.{root}`), and
 * an apex page about one company names it in `x-site-company`; either way it must be
 * eligible for the portal. The apex itself is the platform owner (portal accounts belong to it).
 *
 * @throws when neither a domain match nor a wildcard company exists, or the
 * company does not have the route's module.
 */
export async function resolveCompanyByOrigin(
    origin: string,
    languageCode: string,
): Promise<ICompany> {
    const routeModule = requestContext.getStore()?.routeModule;
    const site = portalSiteSlug(origin)
        ?? (isPortalApexOrigin(origin) ? requestContext.getStore()?.siteCompany : undefined);
    if (site) {
        return findPortalSiteCompany(site, routeModule ?? "core", languageCode);
    }
    const company = isPortalApexOrigin(origin)
        ? await findPlatformCompany(languageCode)
        : await findCompanyByOrigin(origin, languageCode);
    if (routeModule) {
        assertModuleEnabledForCompany(company, routeModule, languageCode);
    }
    return company;
}

async function findCompanyByOrigin(origin: string, languageCode: string): Promise<ICompany> {
    const normalizedOrigin = (origin || "").toLowerCase().split(":")[0];

    if (normalizedOrigin) {
        const specific = await companyService.findOne({
            isActive: true,
            allowedDomains: normalizedOrigin,
        });
        if (specific) {
            return specific;
        }
    }

    const wildcard = await companyService.findOne({isActive: true, allowedDomains: "*", isPlatformOwner: true})
        ?? await companyService.findOne({isActive: true, allowedDomains: "*"});
    if (wildcard) {
        return wildcard;
    }

    throw apiValidationException("company_not_found_for_origin", "origin", [normalizedOrigin || origin], languageCode);
}

/**
 * Company a public signup should join: the origin tenant when one exists,
 * otherwise the company flagged `isDefaultForSignUp`. Accounts belong to the
 * company regardless of modules, so the route's module is not checked. Accounts made
 * anywhere in the portal zone belong to the platform owner.
 */
export async function resolveSignupCompany(
    origin: string,
    languageCode: string,
    options: {session?: ClientSession | null; logger?: serverLogger} = {},
): Promise<ICompany> {
    try {
        return isPortalZoneOrigin(origin)
            ? await findPlatformCompany(languageCode)
            : await findCompanyByOrigin(origin, languageCode);
    } catch {
        const company = await companyService.findOne(
            {isDefaultForSignUp: true},
            {session: options.session, logger: options.logger, languageCode},
        );
        if (!company) {
            throw apiValidationException("default_sign_up_company_not_found", null, null, languageCode);
        }
        return company;
    }
}
