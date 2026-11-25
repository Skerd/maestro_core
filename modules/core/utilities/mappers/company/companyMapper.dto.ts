import {ICompany} from "@coreModule/database/schemas/company/company";
import {Company} from "armonia/src/modules/core/api/company/private/company/company.dto";
import type {StateSimple} from "armonia/src/modules/core/dto/state.dto";
import type {CitySimple} from "armonia/src/modules/core/dto/city.dto";
import type {CountrySimple} from "armonia/src/modules/core/dto/country.dto";
import type {CompanyBlank} from "armonia/src/modules/core/dto/company.dto";
import {StateSimpleSnippet} from "@coreModule/database/schemas/state/state.snippets";
import {CitySimpleSnippet} from "@coreModule/database/schemas/city/city.snippets";
import {CountrySimpleSnippet} from "@coreModule/database/schemas/country/country.snippets";
import {CompanyBlankSnippet} from "@coreModule/database/schemas/company/company.snippets";
import {mapSnippet, nestedEntityToRef} from "@coreModule/utilities/mappers/common.mapper";
import {effectiveCompanyModules} from "@coreModule/utilities/modules/companyModules";
import {mapLifeCycleToDTO, mapOwnershipToDTO, mapSoftDeleteToDTO} from "@coreModule/utilities/mappers/plugin/pluginMappers.dto";

/** Platform-managed fields `companyToDTO` maps; add them to any projected company read. */
// Sub-paths, not `portalApproval`: a parent beside the read fields' own sub-paths is a projection path collision.
export const COMPANY_MODULE_FIELDS = "modules isPlatformOwner hiddenFromPortal isProtected portalApproval.status portalApproval.reason portalApproval.decidedAt verifiedAt";
/** What a member always sees of the companies they belong to: the company switcher's name, description and logo. */
export const COMPANY_BASIC_INFO_SELECT = "name description logo";

export function companyToDTO(company: ICompany | null | undefined): Company | null {
    if (!company) {
        return null;
    }
    return {
        _id: company._id?.toString(),
        name: company.name,
        email: company.email,
        isActive: company.isActive,
        phoneNumber: company.phoneNumber,
        addresses: company.addresses ? company.addresses.map((address) => {
            return {
                _id: address._id?.toString() || "",
                street: address.street,
                postalCode: address.postalCode,
                city: mapSnippet<CitySimple>()(address.city, CitySimpleSnippet),
                state: mapSnippet<StateSimple>()(address.state, StateSimpleSnippet),
                country: mapSnippet<CountrySimple>()(address.country, CountrySimpleSnippet),
                latitude: address.latitude,
                longitude: address.longitude
            }
        }) : undefined,
        description: company.description,
        logo: nestedEntityToRef(company.logo)?.toString(),
        website: company.website,
        linkedin: company.linkedin,
        instagram: company.instagram,
        facebook: company.facebook,
        vat: company.vat,
        siteSlug: company.siteSlug,
        timezone: company.timezone,
        siteHost: company.siteHost,
        siteProvision: company.siteProvision
            ? {
                status: company.siteProvision.status,
                checkedAt: company.siteProvision.checkedAt?.toISOString(),
                lastError: company.siteProvision.lastError,
                steps: {
                    slug: company.siteProvision.steps?.slug ?? false,
                    domain: company.siteProvision.steps?.domain ?? false,
                    reachable: company.siteProvision.steps?.reachable ?? false,
                },
            }
            : undefined,
        parentCompany: mapSnippet<CompanyBlank>()(company.parentCompany, CompanyBlankSnippet),
        allowedDomains: company.allowedDomains,
        modules: effectiveCompanyModules(company),
        isPlatformOwner: company.isPlatformOwner === true,
        hiddenFromPortal: company.hiddenFromPortal === true,
        isProtected: company.isProtected === true,
        portalApproval: company.portalApproval
            ? {
                status: company.portalApproval.status,
                reason: company.portalApproval.reason,
                decidedAt: company.portalApproval.decidedAt?.toISOString(),
            }
            : undefined,
        verifiedAt: company.verifiedAt?.toISOString(),
        signupSource: company.signupSource
            ? {
                via: company.signupSource.via,
                refCompany: mapSnippet<CompanyBlank>()(company.signupSource.refCompany, CompanyBlankSnippet),
            }
            : undefined,
        shopListedOnPortal: company.shopListedOnPortal,
        bankAccount: company.bankAccount ? {
            holder: company.bankAccount.holder,
            iban: company.bankAccount.iban,
            bic: company.bankAccount.bic,
            bankName: company.bankAccount.bankName,
        } : undefined,
        publicAiChat: company.publicAiChat ? {
            enabled: company.publicAiChat.enabled,
            greeting: company.publicAiChat.greeting,
            persona: company.publicAiChat.persona,
            requireIdentification: company.publicAiChat.requireIdentification,
            humanHandoffEnabled: company.publicAiChat.humanHandoffEnabled,
        } : undefined,
        ...mapSoftDeleteToDTO(company),
        ...mapOwnershipToDTO(company),
        ...mapLifeCycleToDTO(company),
    };
}

export function companiesToDTO(companies: ICompany[]): Company[] {
    return companies.map((company) => companyToDTO(company)).filter((dto): dto is Company => dto !== null);
}
