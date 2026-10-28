/**
 * What every portal section needs to list its items in the home catalog.
 *
 * @module portalCatalog
 */

import type {ObjectId} from "mongodb";
import type {Model} from "mongoose";
import type {PortalCatalogItem} from "armonia/src/modules/core/api/portal/public/portal/portal.dto";
import type {PortalBrowseFilters} from "armonia/src/modules/core/api/portal/public/portal/portalBrowse.form.validator";
import {portalCompanyRefs} from "@coreModule/utilities/marketing/portalCompanies";

/** One value of a kind's filter, the first when several were sent. */
export function filterValue(filters: PortalBrowseFilters, name: string): string | undefined {
    const value = filters[name];
    return (Array.isArray(value) ? value[0] : value) || undefined;
}

/** Every value of a kind's filter. */
export function filterValues(filters: PortalBrowseFilters, name: string): string[] {
    const value = filters[name];
    if (value === undefined) return [];
    return (Array.isArray(value) ? value : [value]).filter(Boolean);
}

/** Mongo range clause for `priceMin` / `priceMax`, or undefined when neither is set. */
export function priceRange(priceMin?: number, priceMax?: number): Record<string, number> | undefined {
    if (priceMin == null && priceMax == null) return undefined;
    return {...(priceMin != null && {$gte: priceMin}), ...(priceMax != null && {$lte: priceMax})};
}

/** Catalog items of company-owned rows, each labelled with its company (rows of a gone company are dropped). */
export async function catalogItems<Row extends {company: ObjectId}>(
    rows: Row[],
    toItem: (row: Row) => Omit<PortalCatalogItem, "company">,
): Promise<PortalCatalogItem[]> {
    const companies = await portalCompanyRefs(rows.map((row) => row.company));
    return rows.flatMap((row) => {
        const company = companies.get(row.company.toString());
        return company ? [{...toItem(row), company}] : [];
    });
}

/** The currency code each company prices in, from a module config with a `currency` ref (rental, clinic). */
export async function configCurrencies(configModel: Model<any>, companyIds: ObjectId[]): Promise<Map<string, string>> {
    const configs = await configModel.find({company: {$in: companyIds}, deletedAt: null})
        .select("company currency")
        .populate("currency", "abbreviation")
        .lean<{company: ObjectId; currency?: {abbreviation?: string}}[]>();
    return new Map(configs.flatMap((config) => config.currency?.abbreviation ? [[config.company.toString(), config.currency.abbreviation]] : []));
}
