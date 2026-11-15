import {Schema} from "mongoose";

export function applyCityIndexes(CitySchema: Schema): void {
    // A platform list (D160): every row belongs to the platform company, so no index leads with `company`.
    CitySchema.index({createdAt: -1});
    CitySchema.index({name: 1});
    CitySchema.index({country: 1});
    CitySchema.index({state: 1});
    CitySchema.index({country: 1, name: 1});
    CitySchema.index({state: 1, name: 1});
    CitySchema.index({country: 1, state: 1});
    CitySchema.index({country: 1, state: 1, name: 1});
}
