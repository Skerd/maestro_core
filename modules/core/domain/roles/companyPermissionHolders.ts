import type {ObjectId} from "mongodb";
import {roleService} from "@coreModule/database/schemas/role/role.service";
import {rolePermissionService} from "@coreModule/database/schemas/rolePermission/rolePermission.service";
import {userService} from "@coreModule/database/schemas/user/user.service";

/**
 * The company's active human members who may do what `tag` grants: members of an admin role (which holds every
 * permission) or of a role granted `tag`. Bots, website visitors and members whose access to the company is not
 * active are left out. Without a `tag` only admin roles count.
 *
 * Use it to address a notice to "whoever can act on this" (D71 website chats, D120 RFIs and safety incidents) rather
 * than to one named person. Database errors propagate; the caller decides whether a failed lookup is fatal.
 *
 * @example companyMemberIdsWithPermission(company._id, actionPermissionTag(Rfi, "answer", "self"))
 */
export async function companyMemberIdsWithPermission(companyId: ObjectId, tag: string | undefined): Promise<string[]> {
    const roleFilter: Record<string, unknown>[] = [{company: companyId, isAdmin: true}];
    if (tag) {
        const permission = await rolePermissionService.findOne({tag}, {}, undefined, "_id");
        if (permission) {
            roleFilter.push({company: companyId, permissions: permission._id});
        }
    }

    const roles = await roleService.find({$or: roleFilter}, {}, undefined, "_id");
    if (roles.length === 0) {
        return [];
    }
    const roleIds = roles.map((role) => role._id);

    // Users have no soft delete: a removed member has no active role in the company.
    const members = await userService.find({
        companies: companyId,
        isBot: {$ne: true},
        isVisitor: {$ne: true},
        roles: {
            $elemMatch: {
                company: companyId,
                active: "active",
                roles: {$in: roleIds},
            },
        },
    }, {}, undefined, "_id");

    return members.map((member) => member._id.toString());
}
