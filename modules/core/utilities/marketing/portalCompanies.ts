/**
 * Which companies the portal (and the shop apex) may show.
 *
 * Core rule, shared by every vertical: the company is active, not deleted, has the
 * module, the platform owner has not hidden it, and it is not a sample company (D178). Each vertical adds its own
 * opt-in on top (`listedOnPortal` on its config, `Company.shopListedOnPortal` for the shop).
 *
 * @module portalCompanies
 */

import {ObjectId} from "mongodb";
import type {ICompany} from "@coreModule/database/schemas/company/company";
import {companyService} from "@coreModule/database/schemas/company/company.service";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {companyModuleClause, isModuleEnabledForCompany} from "@coreModule/utilities/modules/companyModules";
import {publicMediaUrl} from "@coreModule/utilities/media/publicMediaUrl";
import {clientHostFor} from "@coreModule/environment";
import {mapSnippet} from "@coreModule/utilities/mappers/common.mapper";
import {CitySimpleSnippet} from "@coreModule/database/schemas/city/city.snippets";
import {StateSimpleSnippet} from "@coreModule/database/schemas/state/state.snippets";
import {CountrySimpleSnippet} from "@coreModule/database/schemas/country/country.snippets";
import type {CitySimple} from "armonia/src/modules/core/dto/city.dto";
import type {StateSimple} from "armonia/src/modules/core/dto/state.dto";
import type {CountrySimple} from "armonia/src/modules/core/dto/country.dto";
import type {PortalCompany, PortalCompanyAddress, PortalCompanyCard} from "armonia/src/modules/core/api/portal/public/portal/portal.dto";
import type {Model} from "mongoose";

/**
 * Mongo clause for companies the portal may list for `moduleName`. A sample company (D178) holds demo data, so neither
 * the apex nor its own site ever shows it, whatever its modules' own settings say.
 */
export function portalCompanyClause(moduleName: string): Record<string, unknown> {
    return {$and: [{isActive: true, deletedAt: null, hiddenFromPortal: {$ne: true}, isSandbox: {$ne: true}}, companyModuleClause(moduleName)]};
}

/**
 * The apex lists a self-serve company only once the platform approved it (D178). Companies the platform created carry
 * no decision and count as approved. A company's own site does not depend on it.
 */
export const PORTAL_APPROVED_CLAUSE = {"portalApproval.status": {$nin: ["pending", "rejected"]}};

export function isPortalApproved(company: Pick<ICompany, "portalApproval">): boolean {
    const status = company.portalApproval?.status;
    return status !== "pending" && status !== "rejected";
}

export function isPortalListable(
    company: Pick<ICompany, "isActive" | "hiddenFromPortal" | "isSandbox" | "modules"> & {deletedAt?: Date | null},
    moduleName: string,
): boolean {
    return company.isActive && !company.deletedAt && company.hiddenFromPortal !== true && company.isSandbox !== true
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

function trimmed(value: string | undefined): string | undefined {
    if (!value) return undefined;
    const text = value.trim();
    return text.length > 0 ? text : undefined;
}

function companyAddresses(addresses: ICompany["addresses"]): PortalCompanyAddress[] | undefined {
    if (!addresses?.length) return undefined;
    return addresses.map((address) => {
        const street = trimmed(address.street);
        const postalCode = trimmed(address.postalCode);
        const city = mapSnippet<CitySimple>()(address.city, CitySimpleSnippet);
        const state = mapSnippet<StateSimple>()(address.state, StateSimpleSnippet);
        const country = mapSnippet<CountrySimple>()(address.country, CountrySimpleSnippet);
        const item: PortalCompanyAddress = {};
        if (street) item.street = street;
        if (postalCode) item.postalCode = postalCode;
        if (city) item.city = city;
        if (state) item.state = state;
        if (country) item.country = country;
        if (address.latitude !== undefined) item.latitude = address.latitude;
        if (address.longitude !== undefined) item.longitude = address.longitude;
        return item;
    });
}

/** Public fields of a company, the same set the shop footer shows for a tenant. */
function mapPortalCompany(company: ICompany): PortalCompany {
    const profile: PortalCompany = {name: company.name};
    const logo = publicMediaUrl(company.logo);
    const email = trimmed(company.email);
    const phoneNumber = trimmed(company.phoneNumber);
    const vat = trimmed(company.vat);
    const website = trimmed(company.website);
    const linkedin = trimmed(company.linkedin);
    const instagram = trimmed(company.instagram);
    const facebook = trimmed(company.facebook);
    const addresses = companyAddresses(company.addresses);
    if (logo) profile.logo = logo;
    if (email) profile.email = email;
    if (phoneNumber) profile.phoneNumber = phoneNumber;
    if (vat) profile.vat = vat;
    if (website) profile.website = website;
    if (linkedin) profile.linkedin = linkedin;
    if (instagram) profile.instagram = instagram;
    if (facebook) profile.facebook = facebook;
    if (addresses) profile.addresses = addresses;
    return profile;
}

/** A company's public profile, for the portal chrome. */
export async function portalCompanyProfile(company: ICompany): Promise<PortalCompany> {
    await company.populate([
        {path: "addresses.city", select: "name"},
        {path: "addresses.state", select: "name code"},
        {path: "addresses.country", select: "name code phoneCode"},
    ]);
    return mapPortalCompany(company);
}

/**
 * The company a portal page is about, named by its site host (`{slug}.{root}`) or by
 * `x-site-company` on the apex (its site slug, or its id), only while it is eligible for
 * `moduleName`. Anything else reads as not found.
 */
export async function findPortalSiteCompany(site: string, moduleName: string, languageCode: string): Promise<ICompany> {
    const slug = site.trim().toLowerCase();
    const company = await companyService.findOne(
        ObjectId.isValid(site) ? {$or: [{siteSlug: slug}, {_id: new ObjectId(site)}]} : {siteSlug: slug},
    );
    if (!company || !isPortalListable(company, moduleName)) {
        throw apiValidationException("portal_company_not_listed", "", null, languageCode);
    }
    return company;
}

/** How the portal addresses a company: its site slug, else its id. */
export function portalSlug(company: {_id: ObjectId; siteSlug?: string | null}): string {
    return company.siteSlug || company._id.toString();
}

/** A page on the company's own site: the portal's client URL with the company's host label (keeps scheme and dev port). */
export function companySiteUrl(company: {_id: ObjectId; siteSlug?: string | null}, path: string): string {
    const url = new URL(clientHostFor("portal"));
    url.hostname = `${portalSlug(company)}.${url.hostname}`;
    return `${url.origin}${path}`;
}

/** The person's account on the portal apex: their bookings and orders at every company in one place (D178). */
export function portalAccountUrl(): string {
    return `${clientHostFor("portal")}/account`;
}

/** Cards for `companyIds`, sorted by name. */
export async function portalCompanyCards(
    companyIds: ObjectId[],
    citiesByCompany: Map<string, string[]>,
): Promise<PortalCompanyCard[]> {
    const companies = await companyService.findPortalCards(companyIds);
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

/** Whom a portal section answers for: every listed company (the apex) or one company's own site. */
export type PortalScope = {companyId?: ObjectId};

/**
 * Companies a portal section shows in `scope`: eligible for `moduleName` and meeting the module's
 * own site rule (`configModel` + `configFilter`, e.g. `publicBookingEnabled`). On the apex they
 * must also have opted in to the listing, on their config (`listedOn`) or company (`companyListedOn`), and a
 * self-serve company must be approved by the platform (D178).
 */
export async function portalListedCompanyIds(
    moduleName: string,
    rule: {
        configModel?: Model<any>;
        configFilter?: Record<string, unknown>;
        listedOn?: Record<string, unknown>;
        companyListedOn?: Record<string, unknown>;
    },
    scope: PortalScope,
): Promise<ObjectId[]> {
    const apex = !scope.companyId;
    const filter: Record<string, unknown> = {
        ...portalCompanyClause(moduleName),
        ...(apex ? {...rule.companyListedOn, ...PORTAL_APPROVED_CLAUSE} : {_id: scope.companyId}),
    };
    if (rule.configModel) {
        const configs = await rule.configModel.find({deletedAt: null, ...rule.configFilter, ...(apex ? rule.listedOn : {company: scope.companyId})})
            .select("company").lean<{company: ObjectId}[]>();
        filter._id = {$in: configs.map((config) => config.company)};
    }
    return companyService.findIds(filter);
}

/** Name and portal slug per company id, for labelling search hits. */
export async function portalCompanyRefs(companyIds: ObjectId[]): Promise<Map<string, {name: string; slug: string}>> {
    const companies = await companyService.findPortalRefs(companyIds);
    return new Map(companies.map((company) => [company._id.toString(), {name: company.name, slug: portalSlug(company)}]));
}

/** City names from the companies' own addresses (sections without locations of their own). */
export async function companyAddressCities(companyIds: ObjectId[]): Promise<Map<string, string[]>> {
    const companies = await companyService.findAddressCities(companyIds);
    return new Map(companies.map((company) => [
        company._id.toString(),
        [...new Set((company.addresses ?? []).map((address) => address.city?.name).filter((name): name is string => !!name))].sort(),
    ]));
}
