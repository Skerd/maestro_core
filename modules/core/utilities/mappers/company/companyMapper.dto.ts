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
import {mapLifeCycleToDTO, mapOwnershipToDTO, mapSoftDeleteToDTO} from "@coreModule/utilities/mappers/plugin/pluginMappers.dto";

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
        shopSlug: company.shopSlug,
        shopHost: company.shopHost,
        shopProvision: company.shopProvision
            ? {
                status: company.shopProvision.status,
                checkedAt: company.shopProvision.checkedAt?.toISOString(),
                lastError: company.shopProvision.lastError,
                steps: {
                    slug: company.shopProvision.steps?.slug ?? false,
                    domain: company.shopProvision.steps?.domain ?? false,
                    reachable: company.shopProvision.steps?.reachable ?? false,
                },
            }
            : undefined,
        parentCompany: mapSnippet<CompanyBlank>()(company.parentCompany, CompanyBlankSnippet),
        allowedDomains: company.allowedDomains,
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
