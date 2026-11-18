import {Router} from "express";
import type {ICompany} from "@coreModule/database/schemas/company/company";
import authMW, {type NotAuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import {asyncHandler} from "@coreModule/utilities/middlewares/asyncHandler";
import {rateLimiter} from "@coreModule/utilities/middlewares/rateLimiter";
import {validateFormZod} from "@coreModule/utilities/middlewares/validateFormZod";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {getPortalProvider, listPortalProviders} from "@coreModule/domain/portal/portalProviderRegistry";
import type {PortalProvider} from "@coreModule/domain/portal/portalProvider.types";
import {
    findPlatformCompany,
    findPortalSiteCompany,
    portalCompanyCards,
    portalCompanyProfile,
    portalSlug,
    type PortalScope,
} from "@coreModule/utilities/marketing/portalCompanies";
import {portalSiteSlug} from "@coreModule/utilities/marketing/portalOrigin";
import {asCrossTenant, withTenant} from "@coreModule/utilities/endpoints/tenantScope";
import {browsePortal, sectionCompanies} from "@coreModule/domain/portal/portalBrowse";
import {portalCompaniesFormSchema} from "armonia/src/modules/core/api/portal/public/portal/portal.form.validators";
import type {PortalCompaniesFormType} from "armonia/src/modules/core/api/portal/public/portal/portal.forms";
import {
    portalBrowseFormSchema,
    type PortalBrowseFormType,
} from "armonia/src/modules/core/api/portal/public/portal/portalBrowse.form.validator";
import type {
    PortalBrowseResponse,
    PortalCompaniesResponse,
    PortalSiteResponse,
} from "armonia/src/modules/core/api/portal/public/portal/portal.dto";

/**
 * Central portal (Public)
 *
 * Read-only views across the portal zone, section by section (shop, car rental,
 * dentists, properties). Sections come from the modules (see `registerAllPortalProviders`);
 * each decides which companies it shows on the apex and on a company's own site.
 * - POST /site      — what this host is: the apex or one company's site, its profile, sections and cities
 * - POST /companies — one section's companies, optionally in one city, or the one a slug names
 * - POST /browse    — the home catalog: one kind a page at a time, or a few of every kind
 *
 * @module modules/core/api/portal
 */
export const basePath = "/api/portal";
export const router = Router();

const DEFAULT_PAGE = 20;

function requireProvider(key: string, languageCode: string): PortalProvider {
    const provider = getPortalProvider(key);
    if (!provider) throw apiValidationException("not_found", "", null, languageCode);
    return provider;
}

/** The company a portal host is: the one its subdomain names, else the platform owner (the apex). */
async function hostCompany(origin: string, languageCode: string): Promise<{company: ICompany; scope: PortalScope}> {
    const slug = portalSiteSlug(origin);
    if (!slug) return {company: await findPlatformCompany(languageCode), scope: {}};
    const company = await findPortalSiteCompany(slug, "core", languageCode);
    return {company, scope: {companyId: company._id}};
}

/**
 * Portal reads stay inside one company on its site and span every listed company on the apex (D16).
 * The providers filter by the listed company ids themselves; this only states the scope.
 */
function inPortalScope<T>(scope: PortalScope, read: () => Promise<T>): Promise<T> {
    return scope.companyId
        ? withTenant(scope.companyId, read)
        : asCrossTenant("the portal apex lists every listed company", read);
}

router.post(
    "/site",
    authMW("public"),
    rateLimiter({windowMs: 60000, max: 60}),
    asyncHandler(async (params: NotAuthenticatedMWType): Promise<PortalSiteResponse> => {
        const {origin, languageCode} = params;
        const {company, scope} = await hostCompany(origin, languageCode);
        return inPortalScope(scope, () => portalSite(company, scope, languageCode));
    }),
);

async function portalSite(company: ICompany, scope: PortalScope, languageCode: string): Promise<PortalSiteResponse> {
    const sections = await Promise.all(listPortalProviders().map(async (provider) => {
        const ids = await provider.companyIds(scope);
        const byCompany = ids.length > 0 ? await provider.citiesByCompany(ids) : new Map<string, string[]>();
        return {key: provider.key, ids, cities: [...byCompany.values()].flat()};
    }));
    const offered = sections.filter((section) => section.ids.length > 0);
    const cities = [...new Set(offered.flatMap((section) => section.cities))]
        .sort((left, right) => left.localeCompare(right, languageCode));
    const description = company.description?.trim();
    return {
        data: {
            scope: scope.companyId ? "company" : "platform",
            company: {
                ...await portalCompanyProfile(company),
                slug: portalSlug({_id: company._id, siteSlug: company.siteSlug}),
                ...(description ? {description} : {}),
                cities: scope.companyId ? cities : [],
                // The apex is the platform owner's own site: its website chat shows there like any company's on its
                // site (the public chat routes resolve the apex to the platform owner).
                chatEnabled: Boolean(company.publicAiChat?.enabled),
            },
            cities,
            sections: offered.map((section) => section.key),
        },
    };
}

router.post(
    "/companies",
    authMW("public"),
    rateLimiter({windowMs: 60000, max: 60}),
    validateFormZod(portalCompaniesFormSchema),
    asyncHandler(async (params: NotAuthenticatedMWType & PortalCompaniesFormType): Promise<PortalCompaniesResponse> => {
        const {languageCode, section, city, slug, offset = 0, limit = DEFAULT_PAGE} = params;
        const provider = requireProvider(section, languageCode);
        const listed = await inPortalScope({}, async () => {
            const {ids, cities} = await sectionCompanies(provider, {}, city);
            return portalCompanyCards(ids, cities);
        });
        const cards = listed.filter((card) => !slug || card.slug === slug);
        return {data: cards.slice(offset, offset + limit), total: cards.length};
    }),
);

router.post(
    "/browse",
    authMW("public"),
    rateLimiter({windowMs: 60000, max: 120}),
    validateFormZod(portalBrowseFormSchema),
    asyncHandler(async (params: NotAuthenticatedMWType & PortalBrowseFormType): Promise<PortalBrowseResponse> => {
        const {origin, languageCode} = params;
        const {scope} = await hostCompany(origin, languageCode);
        return {data: await inPortalScope(scope, () => browsePortal(scope, params, languageCode))};
    }),
);
