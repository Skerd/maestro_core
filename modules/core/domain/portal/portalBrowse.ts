/**
 * The portal's home catalog: products, services, cars, treatments and projects from every
 * section, in one shape. A host sees the companies of its scope only.
 *
 * @module portalBrowse
 */

import type {ObjectId} from "mongodb";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import type {PortalBrowseResponse} from "armonia/src/modules/core/api/portal/public/portal/portal.dto";
import type {PortalBrowseFormType} from "armonia/src/modules/core/api/portal/public/portal/portalBrowse.form.validator";
import type {ICompany} from "@coreModule/database/schemas/company/company";
import {findPlatformCompany, findPortalSiteCompany, type PortalScope} from "@coreModule/utilities/marketing/portalCompanies";
import {portalSiteSlug} from "@coreModule/utilities/marketing/portalOrigin";
import {asCrossTenant, withTenant} from "@coreModule/utilities/endpoints/tenantScope";
import {listPortalProviders} from "./portalProviderRegistry";
import type {PortalProvider} from "./portalProvider.types";

/** Items per kind when every kind is shown at once. */
const RAIL_SIZE = 8;
const PAGE_SIZE = 24;

/** The company a portal host is: the one its subdomain names, else the platform owner (the apex). */
export async function hostCompany(origin: string, languageCode: string): Promise<{company: ICompany; scope: PortalScope}> {
    const slug = portalSiteSlug(origin);
    if (!slug) return {company: await findPlatformCompany(languageCode), scope: {}};
    const company = await findPortalSiteCompany(slug, "core", languageCode);
    return {company, scope: {companyId: company._id}};
}

/**
 * Portal reads stay inside one company on its site and span every listed company on the apex (D16).
 * The providers filter by the listed company ids themselves; this only states the scope.
 */
export function inPortalScope<T>(scope: PortalScope, read: () => Promise<T>): Promise<T> {
    return scope.companyId
        ? withTenant(scope.companyId, read)
        : asCrossTenant("the portal apex lists every listed company", read);
}

/** The section's companies in `scope` with their cities, keeping only those in `city` when given. */
export async function sectionCompanies(provider: PortalProvider, scope: PortalScope, city?: string): Promise<{ids: ObjectId[]; cities: Map<string, string[]>}> {
    const ids = await provider.companyIds(scope);
    const cities = await provider.citiesByCompany(ids);
    const where = city?.trim().toLowerCase();
    if (!where) return {ids, cities};
    return {
        ids: ids.filter((id) => (cities.get(id.toString()) ?? []).some((name) => name.toLowerCase().includes(where))),
        cities,
    };
}

/**
 * With `kind`: one page of that kind, with every filter. Without: the first items of every
 * kind matching the query and city, kinds with nothing left out.
 */
export async function browsePortal(scope: PortalScope, form: PortalBrowseFormType, languageCode: string): Promise<PortalBrowseResponse["data"]> {
    const {kind, query, city, page = 1, limit = PAGE_SIZE} = form;
    // One company lookup per section, shared by the section's kinds.
    const targets = listPortalProviders().flatMap((provider) => {
        const kinds = provider.kinds.filter((providerKind) => !kind || providerKind === kind);
        if (kinds.length === 0) return [];
        const companies = sectionCompanies(provider, scope, city);
        return kinds.map((providerKind) => ({provider, kind: providerKind, companies}));
    });
    if (kind && targets.length === 0) throw apiValidationException("not_found", "kind", null, languageCode);

    const window = kind
        ? {skip: (page - 1) * limit, limit, priceMin: form.priceMin, priceMax: form.priceMax, sort: form.sort, filters: form.filters ?? {}}
        : {skip: 0, limit: RAIL_SIZE, filters: {}};
    const groups = await Promise.all(targets.map(async (target) => {
        const {ids} = await target.companies;
        if (ids.length === 0) return {kind: target.kind, items: [], total: 0};
        const {items, total} = await target.provider.browse({
            kind: target.kind, scope, companyIds: ids, query: query?.trim() || undefined, city: city?.trim() || undefined, languageCode, ...window,
        });
        return {kind: target.kind, items, total};
    }));
    return kind ? groups : groups.filter((group) => group.total > 0);
}
