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
/**
 * A catalog item's rating from a stored average and count (D178): `{rating}` to spread into the item when there are
 * reviews, nothing otherwise. The average keeps one decimal, as the cards show it.
 */
export function catalogRating(average: number | undefined, count: number | undefined): {rating?: {average: number; count: number}} {
    if (!count || count <= 0 || average == null || !Number.isFinite(average)) return {};
    return {rating: {average: Math.round(average * 10) / 10, count}};
}

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

/**
 * The companies a price filter or a price sort may compare: amounts mean nothing across currencies, so only the
 * companies pricing in one currency stay, the one the visitor picked (`f.currency`), else the one most of them use
 * (ties go to the alphabetically first code). Without a price filter or price sort, every company stays.
 */
export function samePriceCurrencyCompanies(
    companyIds: ObjectId[],
    currencies: Map<string, string>,
    params: {priceMin?: number; priceMax?: number; sort?: string; filters: PortalBrowseFilters},
): ObjectId[] {
    const comparesPrices = params.priceMin != null || params.priceMax != null || params.sort === "priceAsc" || params.sort === "priceDesc";
    if (!comparesPrices) return companyIds;
    const picked = filterValue(params.filters, "currency")?.toUpperCase();
    const counts = new Map<string, number>();
    for (const id of companyIds) {
        const code = currencies.get(id.toString());
        if (code) counts.set(code, (counts.get(code) ?? 0) + 1);
    }
    const common = [...counts.entries()].sort(([a, countA], [b, countB]) => countB - countA || a.localeCompare(b))[0]?.[0];
    const currency = picked ?? common;
    return companyIds.filter((id) => currencies.get(id.toString()) === currency);
}
