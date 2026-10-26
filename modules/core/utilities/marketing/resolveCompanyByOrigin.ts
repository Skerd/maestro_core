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
import {isPortalOrigin} from "@coreModule/utilities/marketing/platformShopOrigin";
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
 * On the portal origin the host names no company: the page's company comes from
 * `x-site-company` and must be listable on the portal; without it, the platform
 * owner is the tenant (portal accounts belong to it).
 *
 * @throws when neither a domain match nor a wildcard company exists, or the
 * company does not have the route's module.
 */
export async function resolveCompanyByOrigin(
    origin: string,
    languageCode: string,
): Promise<ICompany> {
    const routeModule = requestContext.getStore()?.routeModule;
    const site = requestContext.getStore()?.siteCompany;
    if (isPortalOrigin(origin) && site) {
        return findPortalSiteCompany(site, routeModule ?? "core", languageCode);
    }
    const company = isPortalOrigin(origin)
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
 * company regardless of modules, so the route's module is not checked. Portal
 * accounts always belong to the platform owner.
 */
export async function resolveSignupCompany(
    origin: string,
    languageCode: string,
    options: {session?: ClientSession | null; logger?: serverLogger} = {},
): Promise<ICompany> {
    try {
        return isPortalOrigin(origin)
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
