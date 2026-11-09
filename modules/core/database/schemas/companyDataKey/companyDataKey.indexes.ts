import {Schema} from "mongoose";

export function applyCompanyDataKeyIndexes(CompanyDataKeySchema: Schema): void {
    // One key per version: two servers creating a company's first key at once keep only one.
    CompanyDataKeySchema.index({company: 1, version: 1}, {unique: true});
}
