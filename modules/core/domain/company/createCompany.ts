import {ObjectId} from "mongodb";
import type {ClientSession, FilterQuery} from "mongoose";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {runModuleCompanyDefaults} from "@coreModule/utilities/modules/moduleCompanyDefaults";
import type {CreateCompanyFormType} from "armonia/src/modules/core/api/company/private/company/company.schema-def";
import {resolveSiteSlug, type SiteSlugError} from "armonia/src/modules/core/api/company/private/company/siteSlug";
import type {ICompany} from "@coreModule/database/schemas/company/company";
import {companyService} from "@coreModule/database/schemas/company/company.service";
import {mediaService} from "@coreModule/database/schemas/media/media.service";
import {countryService} from "@coreModule/database/schemas/country/country.service";
import {stateService} from "@coreModule/database/schemas/state/state.service";
import {cityService} from "@coreModule/database/schemas/city/city.service";
import {PORTAL_ROOT_DOMAIN} from "@coreModule/environment";
import {buildSiteHostAssignment} from "@coreModule/utilities/company/siteHost";
import {isValidTimeZone} from "@coreModule/utilities/time/timeWindows";
import {asCrossTenant, withTenant} from "@coreModule/utilities/endpoints/tenantScope";
import type {serverLogger} from "@coreModule/loggers/serverLog";

/**
 * Creating a company, shared by the panel's "add company" and self-serve sign-up on the portal (D178, BE-02): each
 * trigger checks its own caller, then calls `createCompany`. The company's save hook gives it its default roles (for
 * every module it starts with), its creator as admin, its bot and its cron jobs.
 */

type CompanyWriteContext = {session: ClientSession; logger: serverLogger; languageCode: string};

export const SITE_SLUG_ERRORS = {
    empty: "company_site_slug_empty",
    invalid: "company_site_slug_invalid",
    reserved: "company_site_slug_reserved",
} as const satisfies Record<SiteSlugError, string>;

/** The company's IANA zone as stored (D91): trimmed, `undefined` when empty; an unknown zone is refused. */
export function companyTimeZoneInput(timezone: string | undefined, languageCode: string): string | undefined {
    const zone = timezone?.trim();
    if (!zone) return undefined;
    if (!isValidTimeZone(zone)) throw apiValidationException("company_invalid_timezone", "", null, languageCode, [zone]);
    return zone;
}

export function trimDomains(domains: string[] | undefined): string[] {
    return (domains ?? []).map((domain) => domain.trim()).filter((domain) => domain !== "");
}

export async function assertSiteSlugAvailable(
    slug: string,
    languageCode: string,
    ctx: {session: ClientSession; logger: serverLogger},
    excludeId?: ObjectId,
): Promise<void> {
    const filter: FilterQuery<ICompany> = {siteSlug: slug};
    if (excludeId) {
        filter._id = {$ne: excludeId};
    }
    const taken = await companyService.findOne(filter, {session: ctx.session, logger: ctx.logger, languageCode});
    if (taken) {
        throw apiValidationException("company_site_slug_taken", "siteSlug", [slug], languageCode);
    }
}

/** A VAT is unique when filled (D178): an empty one never clashes. */
export async function assertVatAvailable(vat: string | undefined, ctx: CompanyWriteContext, excludeId?: ObjectId): Promise<void> {
    const value = vat?.trim();
    if (!value) return;
    const filter: FilterQuery<ICompany> = {vat: value};
    if (excludeId) {
        filter._id = {$ne: excludeId};
    }
    if (await companyService.findOne(filter, ctx)) {
        throw apiValidationException("company_exists_with_same_vat", null, null, ctx.languageCode);
    }
}

/** An address as the create and edit forms send it (the edit form's type marks every field optional). */
type CompanyAddressInput = Partial<NonNullable<CreateCompanyFormType["addresses"]>[number]>;

export async function validateAndMapAddresses(
    addresses: readonly CompanyAddressInput[] | undefined,
    ctx: CompanyWriteContext,
) {
    // `addresses` is optional on the form: none sent means none to store.
    return Promise.all(
        (addresses ?? []).map(async (addr) => {
            if (!addr.country) throw apiValidationException("country_not_found", null, null, ctx.languageCode);
            if (!addr.city) throw apiValidationException("city_not_found", null, null, ctx.languageCode);
            const countryId = new ObjectId(addr.country);
            const stateId   = addr.state ? new ObjectId(addr.state) : undefined;
            const cityId    = new ObjectId(addr.city);

            const cityFilter: Record<string, unknown> = {_id: cityId, country: countryId};
            if (stateId) cityFilter.state = stateId;

            const [country, state, city] = await Promise.all([
                countryService.findOne({_id: countryId}, ctx),
                stateId ? stateService.findOne({_id: stateId, country: countryId}, ctx) : Promise.resolve(null),
                cityService.findOne(cityFilter, ctx),
            ]);

            if (!country) throw apiValidationException("country_not_found", null, null, ctx.languageCode);
            if (stateId && !state) throw apiValidationException("state_not_found", null, null, ctx.languageCode);
            if (!city) throw apiValidationException("city_not_found", null, null, ctx.languageCode);

            return {
                street:     addr.street,
                postalCode: addr.postalCode,
                city:       cityId,
                state:      stateId,
                country:    countryId,
                latitude:   addr.latitude,
                longitude:  addr.longitude,
            };
        }),
    );
}

/** The form's chat settings with the schema's defaults for what it left out. */
function publicAiChatInput(chat: NonNullable<CreateCompanyFormType["publicAiChat"]>): NonNullable<ICompany["publicAiChat"]> {
    return {
        enabled: chat.enabled ?? false,
        greeting: chat.greeting,
        persona: chat.persona,
        requireIdentification: chat.requireIdentification ?? false,
        humanHandoffEnabled: chat.humanHandoffEnabled ?? true,
    };
}

export type CreateCompanyInput = Omit<CreateCompanyFormType, "logo" | "parentCompany" | "shopListedOnPortal"> & {
    /** The company the new one belongs to: the creator's own in the panel, the platform's for self-serve sign-up. */
    parentCompanyId: ObjectId;
    /** Where the creator uploaded the logo, when not in the parent (a portal session belongs to the platform). */
    uploadedInCompanyId?: ObjectId;
    /** Media id of the logo the creator uploaded with the form. */
    logo?: string | null;
    /** Modules besides core the company starts with; default none (the platform grants more later). */
    modules?: string[];
    portalApproval?: ICompany["portalApproval"];
    signupSource?: ICompany["signupSource"];
};

export type CreateCompanyContext = CompanyWriteContext & {auditUserId: ObjectId | string};

export async function createCompany(input: CreateCompanyInput, ctx: CreateCompanyContext): Promise<ICompany> {
    const {session, logger, languageCode} = ctx;
    await assertVatAvailable(input.vat, ctx);

    const resolvedSlug = resolveSiteSlug(input.name, input.siteSlug);
    if (resolvedSlug.ok === false) {
        throw apiValidationException(SITE_SLUG_ERRORS[resolvedSlug.error], "siteSlug", [input.siteSlug ?? ""], languageCode);
    }
    await assertSiteSlugAvailable(resolvedSlug.slug, languageCode, {session, logger});
    const zone = companyTimeZoneInput(input.timezone, languageCode);

    const siteHostAssignment = buildSiteHostAssignment({siteSlug: resolvedSlug.slug, rootDomain: PORTAL_ROOT_DOMAIN});
    const domains = trimDomains(input.allowedDomains);

    const newCompanyId = new ObjectId();
    // Places are platform lists (D160): the new company's addresses name the same rows the form offered.
    const ownAddresses = await validateAndMapAddresses(input.addresses, ctx);
    // The logo was uploaded in the creator's company; a company's logo is its own Media row (publicMediaPlugin).
    const logo = input.logo ?? null;
    if (logo) {
        await asCrossTenant("a new company takes over the logo its creator uploaded for it", () =>
            mediaService.updateOne(
                {_id: new ObjectId(logo), company: input.uploadedInCompanyId ?? input.parentCompanyId},
                {$set: {company: newCompanyId}},
                {session, logger},
            ));
    }
    const vat = input.vat?.trim();
    // Its row, roles and public logo are the new company's own data (D16).
    const company = await withTenant(newCompanyId, () => companyService.create(
        {
            _id: newCompanyId,
            name: input.name,
            email: input.email,
            phoneNumber: input.phoneNumber,
            description: input.description,
            logo: logo ? new ObjectId(logo) : null,
            website: input.website,
            linkedin: input.linkedin,
            instagram: input.instagram,
            facebook: input.facebook,
            ...(vat ? {vat} : {}),
            company: input.parentCompanyId,
            siteSlug: siteHostAssignment.siteSlug,
            siteHost: siteHostAssignment.siteHost,
            siteProvision: siteHostAssignment.siteProvision,
            ...(zone ? {timezone: zone} : {}),
            allowedDomains: domains.length > 0 ? domains : ["none.none.com"],
            addresses: ownAddresses,
            parentCompany: input.parentCompanyId,
            modules: ["core", ...(input.modules ?? [])],
            ...(input.publicAiChat ? {publicAiChat: publicAiChatInput(input.publicAiChat)} : {}),
            ...(input.portalApproval ? {portalApproval: input.portalApproval} : {}),
            ...(input.signupSource ? {signupSource: input.signupSource} : {}),
        },
        {session, logger, languageCode, auditUserId: ctx.auditUserId},
    ));
    // What each of its modules sets up for a new company (TD-B254), e.g. property's starter unit types.
    await runModuleCompanyDefaults(company, company.modules ?? [], {session, logger, languageCode});
    return company;
}
