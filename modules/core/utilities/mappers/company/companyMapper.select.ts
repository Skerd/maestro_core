import type {ApiSelectDatum} from "armonia/src/modules/core/types/shared.types";
import type {ICompany} from "@coreModule/database/schemas/company/company";

export function companyToSelect(company: ICompany): ApiSelectDatum {
    return {
        value: company._id.toString(),
        label: company.name,
    };
}

export function companiesToSelect(companies: ICompany[]): ApiSelectDatum[] {
    return companies.map(companyToSelect);
}
