import {Schema} from "mongoose";

export function applyStateIndexes(StateSchema: Schema): void {
    // A platform list (D160): every row belongs to the platform company, so no index leads with `company`.
    StateSchema.index({createdAt: -1});
    StateSchema.index({name: 1});
    StateSchema.index({country: 1});
    StateSchema.index({country: 1, name: 1});
    StateSchema.index({country: 1, code: 1}, {unique: true, partialFilterExpression: {deletedAt: null}});
}
