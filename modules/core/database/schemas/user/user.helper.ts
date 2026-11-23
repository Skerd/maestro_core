/**
 * Company memberships of an existing account: the embedded company role a user gets when joining a company, and the
 * write that adds it. Shared by a company adding an existing user (`api/company/private/users.ts`) and the portal
 * sign-in that joins the platform company (D101, `api/user/public/login.ts`). Also the guest records an account
 * claims once its email is verified (P23.9).
 */
import {ObjectId} from "mongodb";
import type {IUser} from "@coreModule/database/schemas/user/user";
import {userService} from "@coreModule/database/schemas/user/user.service";
import {ensureAiChannel} from "@coreModule/database/schemas/channel/channel.helper";
import type {CrudOptions} from "@coreModule/database/services/baseCrudService";
import {getEnabledModuleNames} from "@coreModule/utilities/modules/enabledModules";
import {moduleBootstrapHook, type AccountVerifiedContext} from "@coreModule/utilities/modules/moduleCompanyDefaults";
import {runAfterCommit} from "@coreModule/utilities/middlewares/transactionUtils";
import {runInTransaction} from "@coreModule/utilities/middlewares/runInTransaction";
import {setTimeout as wait} from "timers/promises";

/** How long a sign-in or activation waits for its guest-record claim before answering (TD-B267). */
export const CLAIM_WAIT_MS = 3000;

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

/**
 * P23.9: a person who booked as a guest and later holds an account with that email, verified, finds those bookings in
 * the account. Every module this server runs gets the account (its `onAccountVerified`) and claims its own guest
 * records. Called when an email gets verified and at each portal sign-in; nothing happens for an unverified account.
 * The claim waits for the caller's transaction to commit and gives each module a transaction of its own, so it can
 * never roll back the sign-in or activation: a module that fails is logged and skipped. The response waits for it up to
 * `CLAIM_WAIT_MS`, so the account's pages already list what it claimed; past that it finishes on its own (a transaction
 * retrying a conflict can take long), and the next portal sign-in takes whatever is still unclaimed (TD-B267).
 */
export async function claimGuestRecords(
    user: Pick<IUser, "_id" | "username" | "isEmailVerified">,
    context: Omit<AccountVerifiedContext, "userId" | "email">,
): Promise<void> {
    if (!user.isEmailVerified) return;
    const email = user.username.trim().toLowerCase();
    const {logger, languageCode} = context;
    await runAfterCommit(context.session, async () => {
        const claims = (async () => {
            for (const moduleName of getEnabledModuleNames()) {
                if (moduleName === "core") continue;
                try {
                    const hook = await moduleBootstrapHook(moduleName, "onAccountVerified");
                    if (hook) await runInTransaction(logger, (session) => hook({userId: user._id, email, session, logger, languageCode}));
                } catch (error) {
                    logger.err(`Module '${moduleName}' could not claim the guest records of account ${user._id}: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
            return true;
        })();
        const finished = await Promise.race([claims, wait(CLAIM_WAIT_MS, false, {ref: false})]);
        if (!finished) logger.warn(`The guest-record claim of account ${user._id} goes on after the response (over ${CLAIM_WAIT_MS} ms)`);
    });
}
