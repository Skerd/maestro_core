import {Schema} from "mongoose";

export function applyCurrencyIndexes(CurrencySchema: Schema): void {
    CurrencySchema.index({company: 1, createdAt: -1});
    CurrencySchema.index({createdAt: -1});
    CurrencySchema.index({company: 1, name: 1});
    CurrencySchema.index({name: 1});
    CurrencySchema.index({abbreviation: 1}, {unique: true});
    CurrencySchema.index({symbol: 1});
    CurrencySchema.index({symbol: 1, abbreviation: 1});
}
