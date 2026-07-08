import {Schema} from "mongoose";

export function applyCityIndexes(CitySchema: Schema): void {
    CitySchema.index({company: 1, createdAt: -1});
    CitySchema.index({createdAt: -1});
    CitySchema.index({company: 1, name: 1});
    CitySchema.index({name: 1});
    CitySchema.index({country: 1});
    CitySchema.index({state: 1});
    CitySchema.index({country: 1, name: 1});
    CitySchema.index({state: 1, name: 1});
    CitySchema.index({country: 1, state: 1});
    CitySchema.index({country: 1, state: 1, name: 1});
}
