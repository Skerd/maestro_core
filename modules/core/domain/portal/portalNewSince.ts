/**
 * What the portal's sections listed after a date (D178, P23.7), asked through their optional `newSince`: the new items
 * of a saved search for its daily alert, and the items a person keeps, as the catalog lists them now. Run inside
 * {@link inPortalScope} for the host the search or the Saved tab belongs to.
 *
 * @module portalNewSince
 */

import type {PortalCatalogItem} from "armonia/src/modules/core/api/portal/public/portal/portal.dto";
import type {PortalBrowseFilters} from "armonia/src/modules/core/api/portal/public/portal/portalBrowse.form.validator";
import type {PortalScope} from "@coreModule/utilities/marketing/portalCompanies";
import {listPortalProviders} from "./portalProviderRegistry";
import {sectionCompanies} from "./portalBrowse";
import {markVerifiedCompanies} from "./portalVerified";

/** A browse query as the home catalog sent it, without its page: what a saved search keeps. */
export type PortalSavedQuery = {
    kind?: string;
    query?: string;
    city?: string;
    priceMin?: number;
    priceMax?: number;
    filters?: PortalBrowseFilters;
};

export type PortalNewItems = {kind: string; items: PortalCatalogItem[]; total: number};

/** "Every listed item", for asking about items by id. */
const ANY_TIME = new Date(0);

/**
 * The items `search` finds that were listed after `since`, per kind, newest first and at most `limit` of each, kinds
 * with nothing new left out. Like the home catalog, a search over every kind uses only its words and city: price and
 * a kind's own filters belong to one kind.
 */
export async function newPortalItemsSince(
    scope: PortalScope,
    search: PortalSavedQuery,
    since: Date,
    options: {languageCode: string; limit: number},
): Promise<PortalNewItems[]> {
    const query = search.query?.trim() || undefined;
    const city = search.city?.trim() || undefined;
    const narrowing = search.kind
        ? {priceMin: search.priceMin, priceMax: search.priceMax, filters: search.filters ?? {}}
        : {filters: {}};
    const groups = await Promise.all(listPortalProviders().map(async (provider) => {
        const newSince = provider.newSince;
        const kinds = provider.kinds.filter((kind) => !search.kind || kind === search.kind);
        if (!newSince || kinds.length === 0) return [];
        const {ids} = await sectionCompanies(provider, scope, city);
        if (ids.length === 0) return [];
        return Promise.all(kinds.map(async (kind) => ({
            kind,
            ...await newSince({kind, scope, companyIds: ids, query, city, ...narrowing, since, limit: options.limit, languageCode: options.languageCode}),
        })));
    }));
    return groups.flat().filter((group) => group.total > 0);
}

/** A kept item: its catalog kind and id. */
export type PortalItemRef = {kind: string; itemId: string};

/**
 * The kept items as this host's catalog lists them now, in the order given. Items the host does not list (another
 * company's site, no longer offered, or from a section that cannot be asked) are left out.
 */
export async function portalItemsByIds(scope: PortalScope, refs: readonly PortalItemRef[], languageCode: string): Promise<PortalCatalogItem[]> {
    const idsByKind = new Map<string, string[]>();
    for (const ref of refs) idsByKind.set(ref.kind, [...(idsByKind.get(ref.kind) ?? []), ref.itemId]);
    const found = new Map<string, PortalCatalogItem>();
    await Promise.all(listPortalProviders().map(async (provider) => {
        const newSince = provider.newSince;
        const asked = provider.kinds.flatMap((kind) => {
            const ids = idsByKind.get(kind);
            return ids ? [{kind, ids}] : [];
        });
        if (!newSince || asked.length === 0) return;
        const {ids: companyIds} = await sectionCompanies(provider, scope);
        if (companyIds.length === 0) return;
        for (const {kind, ids} of asked) {
            const {items} = await newSince({kind, scope, companyIds, filters: {}, since: ANY_TIME, ids, limit: ids.length, languageCode});
            for (const item of items) found.set(`${item.kind}:${item.id}`, item);
        }
    }));
    const items = refs.flatMap((ref) => found.get(`${ref.kind}:${ref.itemId}`) ?? []);
    // The platform verified these companies' NIPT/VAT (D178), as on the home catalog's cards.
    await markVerifiedCompanies(items);
    return items;
}
