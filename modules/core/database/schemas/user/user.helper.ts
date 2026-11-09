/**
 * Company memberships of an existing account: the embedded company role a user gets when joining a company, and the
 * write that adds it. Shared by a company adding an existing user (`api/company/private/users.ts`) and the portal
 * sign-in that joins the platform company (D101, `api/user/public/login.ts`).
 */
import {ObjectId} from "mongodb";
import type {IUser} from "@coreModule/database/schemas/user/user";
import {userService} from "@coreModule/database/schemas/user/user.service";
import {ensureAiChannel} from "@coreModule/database/schemas/channel/channel.helper";
import type {CrudOptions} from "@coreModule/database/services/baseCrudService";

/**
 * Builds the embedded company-role subdocument added to a user when they join a company.
 *
 * @param userRole - Role ID (string) to assign.
 * @param companyId - Company ID for the role.
 * @returns Plain object suitable for `roles` array (active, unsuccessfulLogins, roles, company, etc.).
 */
export function buildCompanyRoleData(userRole: string, companyId: ObjectId) {
    return {
        active: "active",
        unsuccessfulLogins: 0,
        lockedOutUntil: null,
        lastLogin: null,
        rolesCount: 1,
        roles: [new ObjectId(userRole)],
        company: companyId
    };
}

/**
 * Adds an existing user to the company by appending the company and role to their document.
 *
 * @param existingUser - User document to update.
 * @param companyId - Company to add.
 * @param companyRoleData - Role data from buildCompanyRoleData.
 * @param opts - CRUD options for the update.
 */
export async function addExistingUserToCompany(existingUser: IUser, companyId: ObjectId, companyRoleData: ReturnType<typeof buildCompanyRoleData>, opts: CrudOptions): Promise<void> {
    await userService.updateByIdOrThrow(
        existingUser._id,
        {
            $addToSet: {
                companies: companyId
            },
            $push: { roles: companyRoleData }
        },
        opts
    );

    // Ensure this user has their single AI-assistant channel with the company bot.
    await ensureAiChannel({
        userId: existingUser._id,
        companyId,
        session: opts.session ?? null,
        logger: opts.logger,
        languageCode: opts.languageCode,
        auditUserId: opts.auditUserId,
    });
}
