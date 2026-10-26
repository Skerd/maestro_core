import {Router} from "express";
import type {ObjectId} from "mongodb";
import authMW, {type NotAuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import {asyncHandler} from "@coreModule/utilities/middlewares/asyncHandler";
import {rateLimiter} from "@coreModule/utilities/middlewares/rateLimiter";
import {validateFormZod} from "@coreModule/utilities/middlewares/validateFormZod";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {escapeRegex} from "@coreModule/utilities/helpers";
import {getPortalProvider, listPortalProviders} from "@coreModule/domain/portal/portalProviderRegistry";
import type {PortalProvider} from "@coreModule/domain/portal/portalProvider.types";
import {portalCompanyCards} from "@coreModule/utilities/marketing/portalCompanies";
import {
    portalCompaniesFormSchema,
    portalSearchFormSchema,
} from "armonia/src/modules/core/api/portal/public/portal/portal.form.validators";
import type {
    PortalCompaniesFormType,
    PortalSearchFormType,
} from "armonia/src/modules/core/api/portal/public/portal/portal.forms";
import type {
    PortalCompaniesResponse,
    PortalSearchItem,
    PortalSearchResponse,
    PortalSectionsResponse,
} from "armonia/src/modules/core/api/portal/public/portal/portal.dto";

/**
 * Central portal (Public)
 *
 * Read-only views across every company the portal may list, section by section
 * (shop, car rental, dentists, properties). Sections come from the modules (see
 * `registerAllPortalProviders`); each decides which companies opted in.
 * - POST /sections  — sections with how many companies each lists
 * - POST /companies — one section's companies, optionally in one city
 * - POST /search    — "what" and "where" across sections, grouped by section
 *
 * @module modules/core/api/portal
 */
export const basePath = "/api/portal";
export const router = Router();

const DEFAULT_PAGE = 20;
const DEFAULT_SEARCH_LIMIT = 8;

/** The section's companies with their cities, keeping only those in `city` when given. */
async function sectionCompanies(provider: PortalProvider, city?: string): Promise<{ids: ObjectId[]; cities: Map<string, string[]>}> {
    const ids = await provider.listedCompanyIds();
    const cities = await provider.citiesByCompany(ids);
    const where = city?.trim().toLowerCase();
    if (!where) return {ids, cities};
    return {
        ids: ids.filter((id) => (cities.get(id.toString()) ?? []).some((name) => name.toLowerCase().includes(where))),
        cities,
    };
}

function requireProvider(key: string, languageCode: string): PortalProvider {
    const provider = getPortalProvider(key);
    if (!provider) throw apiValidationException("not_found", "", null, languageCode);
    return provider;
}

router.post(
    "/sections",
    authMW("public"),
    rateLimiter({windowMs: 60000, max: 60}),
    asyncHandler(async (): Promise<PortalSectionsResponse> => {
        const data = await Promise.all(listPortalProviders().map(async (provider) => ({
            key: provider.key,
            companies: (await provider.listedCompanyIds()).length,
        })));
        return {data};
    }),
);

router.post(
    "/companies",
    authMW("public"),
    rateLimiter({windowMs: 60000, max: 60}),
    validateFormZod(portalCompaniesFormSchema),
    asyncHandler(async (params: NotAuthenticatedMWType & PortalCompaniesFormType): Promise<PortalCompaniesResponse> => {
        const {languageCode, section, city, offset = 0, limit = DEFAULT_PAGE} = params;
        const provider = requireProvider(section, languageCode);
        const {ids, cities} = await sectionCompanies(provider, city);
        const cards = await portalCompanyCards(ids, cities);
        return {data: cards.slice(offset, offset + limit), total: cards.length};
    }),
);

/** Companies of a section matching the query by name, or every company in the city when there is no query. */
async function companyHits(provider: PortalProvider, ids: ObjectId[], cities: Map<string, string[]>, query: string): Promise<PortalSearchItem[]> {
    const cards = await portalCompanyCards(ids, cities);
    const pattern = query ? new RegExp(escapeRegex(query), "i") : null;
    return cards
        .filter((card) => !pattern || pattern.test(card.name))
        .map((card) => ({
            kind: "company",
            title: card.name,
            subtitle: card.cities.join(", ") || undefined,
            image: card.logo,
            path: provider.companyPath(card),
            company: {name: card.name, slug: card.slug},
        }));
}

router.post(
    "/search",
    authMW("public"),
    rateLimiter({windowMs: 60000, max: 60}),
    validateFormZod(portalSearchFormSchema),
    asyncHandler(async (params: NotAuthenticatedMWType & PortalSearchFormType): Promise<PortalSearchResponse> => {
        const {languageCode, section, limit = DEFAULT_SEARCH_LIMIT} = params;
        const query = params.query?.trim() ?? "";
        const city = params.city?.trim() ?? "";
        if (!query && !city) return {data: []};

        const providers = section ? [requireProvider(section, languageCode)] : listPortalProviders();
        const groups = await Promise.all(providers.map(async (provider) => {
            const {ids, cities} = await sectionCompanies(provider, city);
            if (ids.length === 0) return {key: provider.key, items: []};
            const [companies, items] = await Promise.all([
                companyHits(provider, ids, cities, query),
                query ? provider.search({query, companyIds: ids, limit, languageCode}) : Promise.resolve([]),
            ]);
            return {key: provider.key, items: [...companies, ...items].slice(0, limit)};
        }));
        return {data: groups.filter((group) => group.items.length > 0)};
    }),
);
