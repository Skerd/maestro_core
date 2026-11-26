import {ObjectId} from "mongodb";
import type {ICompany} from "@coreModule/database/schemas/company/company";
import type {IRole} from "@coreModule/database/schemas/role/role";
import type {IUser} from "@coreModule/database/schemas/user/user";
import type {CrudOptions} from "@coreModule/database/services/baseCrudService";
import {roleService} from "@coreModule/database/schemas/role/role.service";
import {userService} from "@coreModule/database/schemas/user/user.service";
import {defaultRoleSuffix, generalAdministratorRole, sysAdminRole} from "@coreModule/database/schemas/role/role.defaults";
import {isPlatformCompany} from "@coreModule/utilities/security/platformAccess";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";

/**
 * A company's two reserved admin roles (D194). Both hold every permission of the company.
 *
 * - **SysAdmin** goes to whoever created the company (`assignCreatorRoles`) and is never given by hand.
 * - **General Administrator** is the company's owner: one person at a time, given and taken away only by the SysAdmin.
 *   The platform company has none, because everything it manages (other companies, platform lists, mail servers, the
 *   report desk) reaches every company: owning it is running the platform.
 *
 * Only a SysAdmin changes the roles or account status of someone who holds an admin role.
 */

type Options = CrudOptions & {languageCode: string};
type CompanyRef = Pick<ICompany, "_id" | "isPlatformOwner">;

const SYS_ADMIN_SUFFIX = defaultRoleSuffix(sysAdminRole);
const GENERAL_ADMINISTRATOR_SUFFIX = defaultRoleSuffix(generalAdministratorRole);

export function isSysAdminRole(role: Pick<IRole, "slug">): boolean {
    return role.slug.endsWith(SYS_ADMIN_SUFFIX);
}

export function isGeneralAdministratorRole(role: Pick<IRole, "slug">): boolean {
    return role.slug.endsWith(GENERAL_ADMINISTRATOR_SUFFIX);
}

/** Whether `userId` holds the SysAdmin role in `companyId`. */
export async function holdsSysAdmin(userId: string, companyId: ObjectId, opts: Options): Promise<boolean> {
    const user = await userService.findById(new ObjectId(userId), opts);
    if (!user) return false;
    const roles = await user.getUserRoles(companyId);
    return roles.some(isSysAdminRole);
}

/**
 * The company's General Administrator role, when the caller may hand it out: a SysAdmin of a company that is not the
 * platform. The role pickers list it next to the ordinary roles for that caller only.
 */
export async function assignableGeneralAdministratorRole(company: CompanyRef, actorId: string, opts: Options): Promise<IRole | null> {
    if (isPlatformCompany(company) || !(await holdsSysAdmin(actorId, company._id, opts))) return null;
    return roleService.findOne({company: company._id, isAdmin: true, slug: {$regex: `${GENERAL_ADMINISTRATOR_SUFFIX}$`}}, opts);
}

/**
 * Checks that every role in `roleIds` is one of the company's and may be given to (or taken from) `targetUserId` by
 * `actorId`, and returns the roles. Ordinary roles pass as before; SysAdmin never does; General Administrator passes
 * only for a SysAdmin, outside the platform company, and, when it is being given, while nobody else holds it.
 *
 * @param targetUserId - The person the roles go to; `null` for someone not created yet.
 * @param giving - Whether the roles are being given (create, invite, a toggle that adds them) rather than taken away.
 * @throws `one_of_the_roles_does_not_exist` when a role is not the company's or is SysAdmin;
 *   `general_administrator_not_in_platform`, `general_administrator_needs_sys_admin`, `general_administrator_already_held`.
 */
export async function assertAssignableRoles(params: {
    roleIds: ObjectId[];
    company: CompanyRef;
    actorId: string;
    targetUserId: ObjectId | null;
    giving: (roleId: ObjectId) => boolean;
    opts: Options;
}): Promise<IRole[]> {
    const {roleIds, company, actorId, targetUserId, giving, opts} = params;
    const roles = await roleService.find({_id: {$in: roleIds}, company: company._id}, opts);
    const usable = roles.filter((role) => !role.isAdmin || isGeneralAdministratorRole(role));
    if (usable.length !== new Set(roleIds.map(String)).size) {
        throw apiValidationException("one_of_the_roles_does_not_exist", "userRole", null, opts.languageCode);
    }

    const generalAdministrator = usable.find(isGeneralAdministratorRole);
    if (!generalAdministrator) return usable;

    if (isPlatformCompany(company)) {
        throw apiValidationException("general_administrator_not_in_platform", "userRole", null, opts.languageCode);
    }
    if (!(await holdsSysAdmin(actorId, company._id, opts))) {
        throw apiValidationException("general_administrator_needs_sys_admin", "userRole", null, opts.languageCode);
    }
    if (giving(generalAdministrator._id)) {
        const heldElsewhere = await userService.exists({
            ...(targetUserId ? {_id: {$ne: targetUserId}} : {}),
            roles: {$elemMatch: {company: company._id, roles: generalAdministrator._id}},
        }, opts);
        if (heldElsewhere) {
            throw apiValidationException("general_administrator_already_held", "userRole", null, opts.languageCode);
        }
    }
    return usable;
}

/**
 * Refuses unless `actorId` may change `target`'s roles or account status in the company: anyone allowed to edit users
 * may change an ordinary member, but only a SysAdmin may change someone who holds an admin role.
 *
 * @throws `administrator_needs_sys_admin`
 */
export async function assertMayChangeMember(target: IUser, company: CompanyRef, actorId: string, opts: Options): Promise<void> {
    const targetRoles = await target.getUserRoles(company._id);
    if (!targetRoles.some((role) => role.isAdmin)) return;
    if (!(await holdsSysAdmin(actorId, company._id, opts))) {
        throw apiValidationException("administrator_needs_sys_admin", "roles", null, opts.languageCode);
    }
}
