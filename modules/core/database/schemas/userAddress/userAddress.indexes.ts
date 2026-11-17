import {Schema} from "mongoose";

export function applyUserAddressIndexes(UserAddressSchema: Schema): void {
    UserAddressSchema.index({user: 1, company: 1});
    UserAddressSchema.index({user: 1, type: 1, isDefault: 1});
}
