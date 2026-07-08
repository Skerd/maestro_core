import {Schema} from "mongoose";

export function applyCountryIndexes(CountrySchema: Schema): void {
    CountrySchema.index({company: 1, createdAt: -1});
    CountrySchema.index({createdAt: -1});
    CountrySchema.index({company: 1, name: 1});
    CountrySchema.index({name: 1});
    CountrySchema.index({company: 1, code: 1});
    CountrySchema.index({code: 1});
    CountrySchema.index({company: 1, phoneCode: 1});
    CountrySchema.index({phoneCode: 1});
}
