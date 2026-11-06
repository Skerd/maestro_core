import {ObjectId} from "mongodb";
import {action} from "@coreModule/api/actionDecorator";
import {userService} from "@coreModule/database/schemas/user/user.service";
import type {IUser} from "@coreModule/database/schemas/user/user";
import type {TransactionRequiredParams} from "@coreModule/utilities/middlewares/transactionUtils";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {validateSingleForm} from "armonia/src/modules/core/utilities/zod/shared.validator";
import {unlockUserRequestFormSchema} from "armonia/src/modules/core/api/company/private/users/unlockUserRequest.form.validator";
import type {ActionMessage} from "armonia/src/modules/core/types/shared.types";
import type {ResendUserEmailFormResponseType} from "armonia/src/modules/core/api/company/private/users/resendUserEmail.form.response.type";

/** What every account-request transition needs from its trigger. */
export type AccountRequestContext = Pick<TransactionRequiredParams, "logger" | "languageCode" | "session" | "actionUserCtx" | "company">;

const auditBy = (target: IUser, ctx: AccountRequestContext) => {
    target.$locals = target.$locals || {};
    target.$locals.auditUserId = ctx.actionUserCtx.userId;
};

async function reload(target: IUser, ctx: AccountRequestContext): Promise<IUser> {
    const {session, logger, languageCode} = ctx;
    return userService.findOneOrThrow({_id: target._id}, {session, logger, languageCode});
}

async function inviterName(target: IUser, ctx: AccountRequestContext): Promise<string> {
    const invitedById = target.requests?.invitation?.invitedBy?._id;
    if (!invitedById) {
        throw apiValidationException("invitation_not_found", "", null, ctx.languageCode);
    }
    const inviter = await userService.findByIdOrThrow(invitedById, {logger: ctx.logger, languageCode: ctx.languageCode});
    return `${inviter.name || ""} ${inviter.surname || ""}`.trim() || inviter.username;
}

function assertOpenInvitationOfCompany(target: IUser, ctx: AccountRequestContext): void {
    if (!ctx.company._id.equals(target.requests?.invitation?.company)) {
        throw apiValidationException("cannot_unlock_invitation", "", null, ctx.languageCode);
    }
    if (!target.requests?.invitation) {
        throw apiValidationException("invitation_not_found", "", null, ctx.languageCode);
    }
    if (target.requests.invitation.accepted === true) {
        throw apiValidationException("invitation_already_accepted", "", null, ctx.languageCode);
    }
}

/* Account-request transitions (BE-02): one function each, run by the staff `@action`s below (D65). */

/** Clears the activation lock and optionally sends the activation email again. */
export async function unlockActivationOf(target: IUser, resendEmail: boolean, ctx: AccountRequestContext): Promise<ActionMessage> {
    const {logger, languageCode, session, actionUserCtx} = ctx;
    logger.start(`Unlocking activation for user ${target._id}`);
    await userService.updateByIdOrThrow(
        target._id,
        {$unset: {"requests.activation.lockedUntil": "", "requests.activation.attempts": ""}},
        {session, logger, languageCode, auditUserId: actionUserCtx.userId},
    );
    if (resendEmail) {
        const fresh = await reload(target, ctx);
        auditBy(fresh, ctx);
        // A pending activation email (email-change flow) first, else the current username.
        await fresh.sendActivationEmail(fresh.requests?.activation?.email || fresh.username, languageCode, session, logger);
        logger.info(`Activation email resent to user ${target._id}`);
    }
    logger.finish(`Activation unlocked for user ${target._id}`);
    return {message: "Activation lock cleared successfully"};
}

/** Clears the password-reset request and optionally sends a new reset email. */
export async function unlockPasswordResetOf(target: IUser, resendEmail: boolean, ctx: AccountRequestContext): Promise<ActionMessage> {
    const {logger, languageCode, session, actionUserCtx} = ctx;
    logger.start(`Unlocking password reset for user ${target._id}`);
    await userService.updateByIdOrThrow(
        target._id,
        {$unset: {"requests.passwordReset": ""}},
        {session, logger, languageCode, auditUserId: actionUserCtx.userId},
    );
    if (resendEmail) {
        const fresh = await reload(target, ctx);
        auditBy(fresh, ctx);
        await fresh.sendForgotPasswordEmail(languageCode, session, logger);
        logger.info(`Password reset email resent to user ${target._id}`);
    }
    logger.finish(`Password reset unlocked for user ${target._id}`);
    return {message: "Password reset lock cleared successfully"};
}

/** Clears the MFA-deactivation request and optionally sends a new deactivation email. */
export async function unlockMfaDeactivationOf(target: IUser, resendEmail: boolean, ctx: AccountRequestContext): Promise<ActionMessage> {
    const {logger, languageCode, session, actionUserCtx} = ctx;
    logger.start(`Unlocking MFA deactivation for user ${target._id}`);
    await userService.updateByIdOrThrow(
        target._id,
        {$unset: {"requests.mfaDeactivation": ""}},
        {session, logger, languageCode, auditUserId: actionUserCtx.userId},
    );
    if (resendEmail) {
        const fresh = await reload(target, ctx);
        auditBy(fresh, ctx);
        await fresh.sendDisableMfaEmail(languageCode, session, logger);
        logger.info(`MFA deactivation email resent to user ${target._id}`);
    }
    logger.finish(`MFA deactivation unlocked for user ${target._id}`);
    return {message: "MFA deactivation lock cleared successfully"};
}

/** Clears the lock on this company's open invitation and optionally sends it again. */
export async function unlockInvitationOf(target: IUser, resendEmail: boolean, ctx: AccountRequestContext): Promise<ActionMessage> {
    const {logger, languageCode, session, actionUserCtx, company} = ctx;
    assertOpenInvitationOfCompany(target, ctx);
    logger.start(`Unlocking invitation for user ${target._id}`);
    await userService.updateByIdOrThrow(
        target._id,
        {$unset: {"requests.invitation.lockedUntil": "", "requests.invitation.attempts": ""}},
        {session, logger, languageCode, auditUserId: actionUserCtx.userId},
    );
    if (resendEmail) {
        const fresh = await reload(target, ctx);
        const welcomeMessage = fresh.requests?.invitation?.welcomeMessage || "";
        await fresh.sendInvitationEmail(welcomeMessage, company.name, await inviterName(fresh, ctx), languageCode, company._id, session, logger);
        logger.info(`Invitation email resent to user ${target._id}`);
    }
    logger.finish(`Invitation unlocked for user ${target._id}`);
    return {message: "Invitation lock cleared successfully"};
}

/** Sends the activation email again unless it is locked; answers when the next send unlocks. */
export async function resendActivationEmailOf(target: IUser, ctx: AccountRequestContext): Promise<ResendUserEmailFormResponseType> {
    const {logger, languageCode, session} = ctx;
    if (!target.requests?.activation) {
        throw apiValidationException("activation_not_found", "", null, languageCode);
    }
    const lockedUntil = target.requests.activation.lockedUntil;
    if (lockedUntil && new Date(lockedUntil).getTime() > Date.now()) {
        throw apiValidationException("activation_link_sent_too_many_times", "", null, languageCode);
    }
    logger.start(`Resending activation email for user ${target._id}`);
    auditBy(target, ctx);
    await target.sendActivationEmail(target.requests.activation.email || target.username, languageCode, session, logger);
    const after = await userService.findByIdOrThrow(target._id, {session, logger, languageCode}, null, "requests.activation");
    logger.finish(`Activation email resent to user ${target._id}`);
    return {message: "Activation email sent successfully", lockedUntil: after.requests?.activation?.lockedUntil};
}

/** Sends this company's open invitation again unless it is locked; answers when the next send unlocks. */
export async function resendInvitationEmailOf(target: IUser, ctx: AccountRequestContext): Promise<ResendUserEmailFormResponseType> {
    const {logger, languageCode, session, company} = ctx;
    assertOpenInvitationOfCompany(target, ctx);
    const lockedUntil = target.requests?.invitation?.lockedUntil;
    if (lockedUntil && new Date(lockedUntil).getTime() > Date.now()) {
        throw apiValidationException("invitation_link_sent_too_many_times", "", null, languageCode);
    }
    logger.start(`Resending invitation email for user ${target._id}`);
    const welcomeMessage = target.requests?.invitation?.welcomeMessage || "";
    await target.sendInvitationEmail(welcomeMessage, company.name, await inviterName(target, ctx), languageCode, company._id, session, logger);
    const after = await userService.findByIdOrThrow(target._id, {session, logger, languageCode}, null, "requests.invitation");
    logger.finish(`Invitation email resent to user ${target._id}`);
    return {message: "Invitation email sent successfully", lockedUntil: after.requests?.invitation?.lockedUntil};
}

type ActionParams = AccountRequestContext & {_id: string; resendEmail?: boolean};

/** Another member of the caller's company, by the body's `_id`: these actions are never about the caller. */
async function companyPeer(params: ActionParams): Promise<IUser> {
    const {_id, actionUserCtx, company, session, languageCode} = params;
    if (_id === String(actionUserCtx.userId)) {
        throw apiValidationException("user_permissions_not_sufficient", "", null, languageCode);
    }
    const target = await userService.findOne({_id: new ObjectId(_id), companies: company._id}, {session, languageCode});
    if (!target) {
        throw apiValidationException("cant_access_this_user", "_id", null, languageCode);
    }
    return target;
}

const ON_OTHERS = {
    auth: "private",
    rateLimit: {windowMs: 60000, max: 30},
    transaction: true,
    schema: validateSingleForm,
    // The target is another user, named in the body: the `others` permission, whoever calls (D65).
    scope: "others",
} as const;
const WITH_RESEND = {...ON_OTHERS, schema: unlockUserRequestFormSchema};

/** Staff actions on a company member's account requests (D65, TD-B07): POST /api/company/users/<method>. */
export class UserActions {
    @action(WITH_RESEND)
    async unlockActivation(params: ActionParams): Promise<ActionMessage> {
        return unlockActivationOf(await companyPeer(params), params.resendEmail === true, params);
    }

    @action(WITH_RESEND)
    async unlockPasswordReset(params: ActionParams): Promise<ActionMessage> {
        return unlockPasswordResetOf(await companyPeer(params), params.resendEmail === true, params);
    }

    @action(WITH_RESEND)
    async unlockMfaDeactivation(params: ActionParams): Promise<ActionMessage> {
        return unlockMfaDeactivationOf(await companyPeer(params), params.resendEmail === true, params);
    }

    @action(WITH_RESEND)
    async unlockInvitation(params: ActionParams): Promise<ActionMessage> {
        return unlockInvitationOf(await companyPeer(params), params.resendEmail === true, params);
    }

    @action(ON_OTHERS)
    async resendActivationEmail(params: ActionParams): Promise<ResendUserEmailFormResponseType> {
        return resendActivationEmailOf(await companyPeer(params), params);
    }

    @action(ON_OTHERS)
    async resendInvitationEmail(params: ActionParams): Promise<ResendUserEmailFormResponseType> {
        return resendInvitationEmailOf(await companyPeer(params), params);
    }
}
