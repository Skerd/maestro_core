import {Schema} from "mongoose";

export function applyStateIndexes(StateSchema: Schema): void {
    StateSchema.index({company: 1, createdAt: -1});
    StateSchema.index({createdAt: -1});
    StateSchema.index({company: 1, name: 1});
    StateSchema.index({name: 1});
    StateSchema.index({country: 1});
    StateSchema.index({country: 1, name: 1});
    StateSchema.index({country: 1, code: 1}, {unique: true});
}
