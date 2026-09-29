import type {CompanyBlank} from "armonia/src/modules/core/dto/company.dto";
import type {ICompany} from "@coreModule/database/schemas/company/company";
import {defineSnippet} from "@coreModule/database/utilities/snippet";

export const CompanyBlankSnippet = defineSnippet<ICompany, CompanyBlank>()({
    keys: {
        _id: {},
        name: {},
        vat: {},
    },
});
