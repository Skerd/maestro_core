/**
 * Which companies the portal (and the shop apex) may show.
 *
 * Core rule, shared by every vertical: the company is active, not deleted, has the
 * module, and the platform owner has not hidden it. Each vertical adds its own opt-in
 * on top (`listedOnPortal` on its config, `Company.shopListedOnPortal` for the shop).
 *
 * @module portalCompanies
 */

import {ObjectId} from "mongodb";
import type {ICompany} from "@coreModule/database/schemas/company/company";
import {companyService} from "@coreModule/database/schemas/company/company.service";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {companyModuleClause, isModuleEnabledForCompany} from "@coreModule/utilities/modules/companyModules";
import Company from "@coreModule/database/schemas/company/company";
import {publicMediaUrl} from "@coreModule/utilities/media/publicMediaUrl";
import type {PortalCompanyCard} from "armonia/src/modules/core/api/portal/public/portal/portal.dto";
import type {Model} from "mongoose";

/** Mongo clause for companies the portal may list for `moduleName`. */
export function portalCompanyClause(moduleName: string): Record<string, unknown> {
    return {$and: [{isActive: true, deletedAt: null, hiddenFromPortal: {$ne: true}}, companyModuleClause(moduleName)]};
}

export function isPortalListable(
    company: Pick<ICompany, "isActive" | "hiddenFromPortal" | "modules"> & {deletedAt?: Date | null},
    moduleName: string,
): boolean {
    return company.isActive && !company.deletedAt && company.hiddenFromPortal !== true
        && isModuleEnabledForCompany(company, moduleName);
}

/** The platform-owner company: owner of portal accounts and of portal pages about no company. */
export async function findPlatformCompany(languageCode: string): Promise<ICompany> {
    const company = await companyService.findOne({isPlatformOwner: true, isActive: true});
    if (!company) {
        throw apiValidationException("company_not_found_for_origin", "origin", ["portal"], languageCode);
    }
    return company;
}

/**
 * The company a portal page is about (`x-site-company`: its shop slug, or its id), only
 * while it may be listed for `moduleName`. Anything else reads as not found.
 */
export async function findPortalSiteCompany(site: string, moduleName: string, languageCode: string): Promise<ICompany> {
    const slug = site.trim().toLowerCase();
    const company = await companyService.findOne(
        ObjectId.isValid(site) ? {$or: [{shopSlug: slug}, {_id: new ObjectId(site)}]} : {shopSlug: slug},
    );
    if (!company || !isPortalListable(company, moduleName)) {
        throw apiValidationException("portal_company_not_listed", "", null, languageCode);
    }
    return company;
}

/** How the portal addresses a company: its shop slug, else its id. */
export function portalSlug(company: {_id: ObjectId; shopSlug?: string | null}): string {
    return company.shopSlug || company._id.toString();
}

/** Cards for `companyIds`, sorted by name. */
export async function portalCompanyCards(
    companyIds: ObjectId[],
    citiesByCompany: Map<string, string[]>,
): Promise<PortalCompanyCard[]> {
    const companies = await Company.find({_id: {$in: companyIds}})
        .select("_id name shopSlug logo description")
        .sort({name: 1})
        .lean<{_id: ObjectId; name: string; shopSlug?: string; logo?: ObjectId; description?: string}[]>();
    return companies.map((company) => ({
        _id: company._id.toString(),
        name: company.name,
        slug: portalSlug(company),
        logo: publicMediaUrl(company.logo),
        description: company.description,
        cities: citiesByCompany.get(company._id.toString()) ?? [],
    }));
}

/** City names per company from a location-like model with `address.city` (a City ref). */
export async function addressCitiesByCompany(
    model: Model<any>,
    companyIds: ObjectId[],
    filter: Record<string, unknown> = {},
): Promise<Map<string, string[]>> {
    const rows = await model.find({company: {$in: companyIds}, deletedAt: null, ...filter})
        .select("company address.city")
        .populate({path: "address.city", select: "name"})
        .lean<{company: ObjectId; address?: {city?: {name?: string}}}[]>();
    const cities = new Map<string, Set<string>>();
    for (const row of rows) {
        const name = row.address?.city?.name;
        if (!name) continue;
        const key = row.company.toString();
        cities.set(key, (cities.get(key) ?? new Set()).add(name));
    }
    return new Map([...cities].map(([key, names]) => [key, [...names].sort()]));
}

/**
 * Companies a portal section lists: eligible for `moduleName` and opted in, either through
 * the module's config document (`configModel` + `configFilter`, e.g. `listedOnPortal`) or a
 * company field (`companyFilter`).
 */
export async function portalListedCompanyIds(
    moduleName: string,
    optIn: {configModel?: Model<any>; configFilter?: Record<string, unknown>; companyFilter?: Record<string, unknown>},
): Promise<ObjectId[]> {
    const filter: Record<string, unknown> = {...portalCompanyClause(moduleName), ...optIn.companyFilter};
    if (optIn.configModel) {
        const configs = await optIn.configModel.find({deletedAt: null, ...optIn.configFilter}).select("company").lean<{company: ObjectId}[]>();
        filter._id = {$in: configs.map((config) => config.company)};
    }
    const companies = await Company.find(filter).select("_id").lean<{_id: ObjectId}[]>();
    return companies.map((company) => company._id);
}

/** Name and portal slug per company id, for labelling search hits. */
export async function portalCompanyRefs(companyIds: ObjectId[]): Promise<Map<string, {name: string; slug: string}>> {
    const companies = await Company.find({_id: {$in: companyIds}}).select("_id name shopSlug").lean<{_id: ObjectId; name: string; shopSlug?: string}[]>();
    return new Map(companies.map((company) => [company._id.toString(), {name: company.name, slug: portalSlug(company)}]));
}

/** City names from the companies' own addresses (sections without locations of their own). */
export async function companyAddressCities(companyIds: ObjectId[]): Promise<Map<string, string[]>> {
    const companies = await Company.find({_id: {$in: companyIds}})
        .select("_id addresses.city")
        .populate({path: "addresses.city", select: "name"})
        .lean<{_id: ObjectId; addresses?: {city?: {name?: string}}[]}[]>();
    return new Map(companies.map((company) => [
        company._id.toString(),
        [...new Set((company.addresses ?? []).map((address) => address.city?.name).filter((name): name is string => !!name))].sort(),
    ]));
}
