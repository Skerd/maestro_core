/**
 * A portal session acting for one of its user's companies (D172, CORE-03). A portal account's session lives in the
 * platform company. A route that declares a member-company action lets a portal-zone request name another company the
 * same user belongs to (`actAs` in the body) and run that one action there, per request, without switching the
 * session: the user's membership there must be active, verified and not locked out, the company active with the
 * route's module, and the user's role there must grant the action's permission tag, exactly as in that company's panel.
 * A request without `actAs`, or from outside the portal zone, is the session's own, unchanged.
 *
 * @module utilities/security/memberCompany
 */

import {ObjectId} from "mongodb";
import type {Model} from "mongoose";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {companyService} from "@coreModule/database/schemas/company/company.service";
import type {ICompany} from "@coreModule/database/schemas/company/company";
import type {IUser} from "@coreModule/database/schemas/user/user";
import {effectiveCompanyModules, isModuleEnabledForCompany} from "@coreModule/utilities/modules/companyModules";
import {actionPermissionTag} from "@coreModule/utilities/security/actionPermissions";
import {nestedEntityToRef} from "@coreModule/utilities/mappers/common.mapper";

/** The one action a route lets a portal session run for a member company: its model and permission name. */
export type MemberCompanyAction = {model: Model<any>; method: string};

/** The company a request acts for, and the caller's access there. */
export type MemberCompanyAccess = {company: ICompany; isAdmin: boolean; permissions: string[]; modules: string[]};

const COMPANY_FIELDS = "name isActive modules isPlatformOwner timezone suspendedAt";

/**
 * The company `actAs` names, checked for this user and action; refused with the same errors the panel gives
 * (`company_role_not_found`, `user_locked_out`, `user_not_active`, `account_banned`, `company_is_inactive`, `company_suspended`,
 * `module_not_enabled`, `user_permissions_not_sufficient`).
 */
export async function resolveMemberCompany(
    user: IUser,
    actAs: unknown,
    action: MemberCompanyAction,
    routeModule: string | undefined,
    languageCode: string,
): Promise<MemberCompanyAccess> {
    if (typeof actAs !== "string" || !ObjectId.isValid(actAs)) throw apiValidationException("company_role_not_found", "actAs", null, languageCode);
    const company = await companyService.findById(new ObjectId(actAs), {}, [], COMPANY_FIELDS);
    if (!company) throw apiValidationException("company_role_not_found", "actAs", null, languageCode);
    // A member whose membership is active and not locked out (the panel's own sign-in checks).
    await user.checkAccountAccessibility(company._id, languageCode);
    if (!company.isActive) throw apiValidationException("company_is_inactive", "company", null, languageCode);
    // Suspended by the platform (D191): nobody acts for it, from the panel or the portal.
    if (company.suspendedAt) throw apiValidationException("company_suspended", "company", null, languageCode);
    if (routeModule && !isModuleEnabledForCompany(company, routeModule)) throw apiValidationException("module_not_enabled", "module", null, languageCode);
    const modules = effectiveCompanyModules(company);
    const {isAdmin, permissions} = await user.getCompanyAccess(company._id, modules);
    const tag = actionPermissionTag(action.model, action.method, "self");
    if (!tag || !permissions.includes(tag)) throw apiValidationException("user_permissions_not_sufficient", null, null, languageCode);
    return {company, isAdmin, permissions, modules};
}

/**
 * The user's companies a portal session may run `action` for (the ones `resolveMemberCompany` accepts), for a page
 * that lets the user pick one. The session's own company is left out.
 */
export async function memberCompaniesFor(
    user: IUser,
    sessionCompany: ObjectId,
    action: MemberCompanyAction,
    routeModule: string | undefined,
    languageCode: string,
): Promise<ICompany[]> {
    const ids = (user.roles ?? [])
        .map((role) => nestedEntityToRef(role.company))
        .filter((id): id is ObjectId => !!id && !sessionCompany.equals(id));
    const allowed: ICompany[] = [];
    for (const id of ids) {
        try {
            allowed.push((await resolveMemberCompany(user, String(id), action, routeModule, languageCode)).company);
        } catch {
            // Not a company this user may act for here: left out.
        }
    }
    return allowed;
}
