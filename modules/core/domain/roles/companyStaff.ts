import type {ObjectId} from "mongodb";
import type {FilterQuery} from "mongoose";
import type {IUser} from "@coreModule/database/schemas/user/user";
import {roleService} from "@coreModule/database/schemas/role/role.service";
import type {CrudOptions} from "@coreModule/database/services/baseCrudService";

/**
 * The company's staff: members whose active membership holds one of its panel roles (any role but the sign-up one),
 * bots excluded. The users page's "Administration" tab, as opposed to its web users (the sign-up role, or none).
 * The internal chat is between staff only; a web user reaches the company through its website chat (D168).
 */
export async function companyStaffFilter(companyId: ObjectId, options: CrudOptions): Promise<FilterQuery<IUser>> {
    const staffRoles = await roleService.find({company: companyId, isSignupDefault: false}, options, undefined, "_id");
    return {
        isBot: {$ne: true},
        roles: {$elemMatch: {company: companyId, active: "active", roles: {$in: staffRoles.map((role) => role._id)}}},
    };
}
