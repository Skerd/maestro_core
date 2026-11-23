/**
 * City landing pages (D181): a section gets a page for one city (`/car-rental/in/tirane`) once it lists enough items
 * there, so search engines find "car rental in Tirana" and a city with one listing does not look empty (P23.11).
 *
 * @module portalLandings
 */

import type {PortalLanding} from "armonia/src/modules/core/api/portal/public/portal/portal.dto";
import {portalCitySlug} from "armonia/src/modules/core/helpers/slug";
import {PORTAL_LANDING_MIN_LISTINGS} from "@coreModule/environment";
import type {PortalScope} from "@coreModule/utilities/marketing/portalCompanies";
import {sectionCompanies} from "./portalBrowse";
import {listPortalProviders} from "./portalProviderRegistry";

/** Counting every section in every city takes a query per kind and city: the apex reads it on every visit. */
const CACHE_MS = 5 * 60 * 1000;
let cached: {at: number; landings: Promise<PortalLanding[]>} | null = null;

/** The landing pages of the apex, section by section in display order, cities by name. A company's own site has none. */
export function portalLandings(scope: PortalScope, languageCode: string): Promise<PortalLanding[]> {
    if (scope.companyId) return Promise.resolve([]);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.landings;
    const landings = countLandings(scope, languageCode);
    cached = {at: Date.now(), landings};
    // A failed count is not kept: the next visit counts again.
    landings.catch(() => {
        cached = null;
    });
    return landings;
}

/** Forget the counts (tests). */
export function clearPortalLandings(): void {
    cached = null;
}

async function countLandings(scope: PortalScope, languageCode: string): Promise<PortalLanding[]> {
    const perSection = await Promise.all(listPortalProviders().map(async (provider) => {
        const {ids, cities} = await sectionCompanies(provider, scope);
        if (ids.length === 0) return [];
        const names = [...new Set([...cities.values()].flat())].sort((left, right) => left.localeCompare(right, languageCode));
        const counted = await Promise.all(names.map(async (city) => {
            // The same companies and items the landing page's catalog shows for this city.
            const {ids: inCity} = await sectionCompanies(provider, scope, city);
            if (inCity.length === 0) return {section: provider.key, city, count: 0};
            const totals = await Promise.all(provider.kinds.map((kind) => provider.browse({
                kind, scope, companyIds: inCity, city, skip: 0, limit: 1, filters: {}, languageCode,
            }).then((page) => page.total)));
            return {section: provider.key, city, count: totals.reduce((sum, total) => sum + total, 0)};
        }));
        // Two spellings of one city ("Tirana", "Tiranë") share an address: the one with more listings keeps it.
        const bySlug = new Map<string, PortalLanding>();
        for (const landing of counted) {
            const slug = portalCitySlug(landing.city);
            const kept = bySlug.get(slug);
            if (slug && (!kept || landing.count > kept.count)) bySlug.set(slug, landing);
        }
        return [...bySlug.values()].filter((landing) => landing.count >= PORTAL_LANDING_MIN_LISTINGS);
    }));
    return perSection.flat();
}
