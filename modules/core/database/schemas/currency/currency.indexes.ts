import {Schema} from "mongoose";

export function applyCurrencyIndexes(CurrencySchema: Schema): void {
    // A platform list (D160): every row belongs to the platform company, so no index leads with `company`.
    CurrencySchema.index({createdAt: -1});
    CurrencySchema.index({name: 1});
    CurrencySchema.index({abbreviation: 1}, {unique: true, partialFilterExpression: {deletedAt: null}});
    CurrencySchema.index({symbol: 1});
    CurrencySchema.index({symbol: 1, abbreviation: 1});
}
