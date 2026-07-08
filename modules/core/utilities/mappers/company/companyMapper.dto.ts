import {ICompany} from "@coreModule/database/schemas/company/company";
import {Company} from "armonia/src/modules/core/api/company/private/company/company.dto";
import {mapPopulatedRef, mapPopulatedSimpleCompany} from "@coreModule/utilities/mappers/common.mapper";
import {mapOwnershipToDTO, mapSoftDeleteToDTO} from "@coreModule/utilities/mappers/plugin/pluginMappers.dto";

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
                city: mapPopulatedRef(address.city),
                state: mapPopulatedRef(address.state),
                country: mapPopulatedRef(address.country),
                latitude: address.latitude,
                longitude: address.longitude
            }
        }) : undefined,
        description: company.description,
        logo: company.logo?._id?.toString(),
        website: company.website,
        vat: company.vat,
        parentCompany: company.parentCompany ? mapPopulatedSimpleCompany(company.parentCompany) : undefined,
        allowedDomains: company.allowedDomains,
        ...mapSoftDeleteToDTO(company),
        ...mapOwnershipToDTO(company)
    };
}

export function companiesToDTO(companies: ICompany[]): Company[] {
    return companies.map((company) => companyToDTO(company)).filter((dto): dto is Company => dto !== null);
}
