import {Schema} from "mongoose";

export function applyCountryIndexes(CountrySchema: Schema): void {
    // A platform list (D160): every row belongs to the platform company, so no index leads with `company`.
    CountrySchema.index({createdAt: -1});
    CountrySchema.index({name: 1});
    CountrySchema.index({code: 1}, {unique: true, partialFilterExpression: {deletedAt: null}});
    CountrySchema.index({phoneCode: 1});
}
