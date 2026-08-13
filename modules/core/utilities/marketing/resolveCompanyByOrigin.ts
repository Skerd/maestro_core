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

import {ICompany} from "@coreModule/database/schemas/company/company";
import {companyService} from "@coreModule/database/schemas/company/company.service";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";

/**
 * Resolve the tenant company from a public request's origin.
 *
 * Falls back to the first active company whose `allowedDomains` contains `"*"`,
 * which is what makes local development (localhost, preview hosts) work without
 * per-environment domain configuration.
 *
 * @throws when neither a domain match nor a wildcard company exists.
 */
export async function resolveCompanyByOrigin(
    origin: string,
    languageCode: string,
): Promise<ICompany> {
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

    const wildcard = await companyService.findOne({
        isActive: true,
        allowedDomains: "*",
    });
    if (wildcard) {
        return wildcard;
    }

    throw apiValidationException("company_not_found_for_origin", "origin", [normalizedOrigin || origin], languageCode);
}
