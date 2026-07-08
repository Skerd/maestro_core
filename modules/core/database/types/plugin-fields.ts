import {IUser} from "@coreModule/database/schemas/user/user";
import {ICompany} from "@coreModule/database/schemas/company/company";

/** Fields added by ownershipPlugin. Use when defining schema interfaces that use ownershipPlugin. */
export interface IOwnershipPluginFields {
    createdBy?: IUser;
    company?: ICompany;
}

/** Fields added by softDeletePlugin. Use when defining schema interfaces that use softDeletePlugin. */
export interface ISoftDeletePluginFields {
    deletedAt?: Date;
    deletedBy?: IUser;
}

export interface ILifeCyclePluginFields {
    createdAt?: Date;
    updatedAt?: Date;
}
