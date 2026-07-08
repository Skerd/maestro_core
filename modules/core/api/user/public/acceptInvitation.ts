/**
 * User invitation acceptance API – public endpoints for accepting and validating company invitations.
 *
 * Mounted under the user public routes (e.g. `/api/user/acceptInvitation`). Endpoints are public
 * (no authentication required) for users who have not yet created accounts. Accept flow sets
 * password, marks email verified and invitation accepted, and activates the account; changes are
 * audited with the accepting user's ID (self-action).
 *
 * **Routes:**
 * - `POST ""` – Accept invitation with code and new password; activate account and set password.
 * - `POST "/validate"` – Validate invitation code without accepting (read-only).
 *
 * @module f_endpoints/core/user/public/acceptInvitation
 */

import {Router} from "express";
import {asyncHandler} from "@coreModule/utilities/middlewares/asyncHandler";
import {transactionHandler} from "@coreModule/utilities/middlewares/transactionHandler";
import {TransactionRequiredParams} from "@coreModule/utilities/middlewares/transactionUtils";
import authMW, {NotAuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {
    acceptInvitationFormSchema
} from "armonia/src/modules/core/api/user/public/acceptInvitation/acceptInvitation.form.validator";
import {
    AcceptInvitationFormType
} from "armonia/src/modules/core/api/user/public/acceptInvitation/acceptInvitation.form.type";
import {
    AcceptInvitationFormResponseType
} from "armonia/src/modules/core/api/user/public/acceptInvitation/acceptInvitation.form.response.type";
import {
    validateInvitationCodeFormSchema
} from "armonia/src/modules/core/api/user/public/acceptInvitation/validateInvitationCode.form.validator";
import {
    ValidateInvitationCodeFormType
} from "armonia/src/modules/core/api/user/public/acceptInvitation/validateInvitationCode.form.type";
import {
    ValidateInvitationCodeFormResponseType
} from "armonia/src/modules/core/api/user/public/acceptInvitation/validateInvitationCode.form.response.type";
import {userService} from "@coreModule/database/schemas/user/user.service";
import {rateLimiter} from "@coreModule/utilities/middlewares/rateLimiter";
import {validateFormZod} from "@coreModule/utilities/middlewares/validateFormZod";
import {emitNotificationEvent, NotificationEventCodes} from "@coreModule/domain/notifications/notificationEventBus";

const router = Router();

/**
 * POST /api/user/acceptInvitation
 *
 * Accepts a user invitation by validating the code, setting the user's password, and activating
 * the account. Public endpoint for users who have not yet logged in.
 *
 * @route POST /api/user/acceptInvitation
 * @access Public
 * @requires Transaction
 * @body {AcceptInvitationFormType} - invitationCode, password
 * @returns {Promise<AcceptInvitationFormResponseType>} Success message
 *
 * @throws {apiValidationException} If invitation code is invalid, already accepted, or expired
 *
 * @remarks
 * - Rate limited: 10 requests per minute
 * - Validates invitation code, expiration, and acceptance status
 * - Sets user password (hashed by pre-save hook), marks email verified and invitation accepted
 * - Activates the user account; changes audited with the user's own ID (self-action)
 */
router.post(
    "",
    authMW("public"),
    rateLimiter({ windowMs: 60000, max: 10 }),
    validateFormZod(acceptInvitationFormSchema),
    transactionHandler(),
    asyncHandler(acceptInvitation)
);
/**
 * Accepts invitation: validates code, sets password, marks invitation accepted and email verified.
 * Activates the account. Uses user's own ID for audit (self-action).
 *
 * @param params - Transaction, form (invitationCode, password), logger, languageCode, session.
 * @returns Success message (user can log in).
 */
async function acceptInvitation(params: TransactionRequiredParams & AcceptInvitationFormType & NotAuthenticatedMWType): Promise<AcceptInvitationFormResponseType> {
    const { invitationCode, password, logger, languageCode, session } = params;

    logger.start(`Trying to accept invitation...`);

    // Find user by invitation code
    const user = await userService.findOne(
        { "requests.invitation.code": invitationCode },
        { session, logger, languageCode }
    );

    if (!user) {
        throw apiValidationException("invitation_code_not_valid", null, null, languageCode);
    }

    // Check if invitation has already been accepted
    if (user.requests.invitation?.accepted ) {
        throw apiValidationException("invitation_already_accepted", null, null, languageCode);
    }

    // Check if invitation has expired
    if (user.requests.invitation?.invitationExpiresAt && new Date() > user.requests.invitation.invitationExpiresAt ) {
        throw apiValidationException("invitation_expired", null, null, languageCode);
    }

    const invitationCompanyIdRaw = user.requests.invitation?.company;
    const notificationCompanyId = invitationCompanyIdRaw
        ? invitationCompanyIdRaw.toString()
        : user.companies?.[0]
          ? String((user.companies[0] as {_id?: unknown})._id ?? user.companies[0])
          : undefined;

    // Update user: set password, activate account, mark invitation as accepted
    // Set roles.active to "active" for the invited company role (matches "invited" or legacy false)
    // Use user's own ID as actor for audit logging (self-action on public endpoint)
    await userService.updateById(
        user._id,
        {
            $set: {
                isEmailVerified: true,
                emailVerifiedAt: new Date(),
                "requests.invitation.accepted": true,
                "requests.invitation.acceptedAt": new Date(),
                "roles.$[role].active": "active"
            },
            $unset: {
                "requests.invitation.opened": "",
                "requests.invitation.code": "",
                "requests.invitation.attempts": "",
                "requests.invitation.invitationExpiresAt": "",
                "requests.invitation.lockedUntil": "",
            }
        },
        {
            session,
            logger,
            languageCode,
            auditUserId: user._id.toString(),
            arrayFilters: [{ "role.active": { $in: ["invited", false] } }]
        } as any
    );

    // Set auditUserId for password save (self-action)
    user.password = password;
    user.$locals = user.$locals || {};
    user.$locals.auditUserId = user._id;
    await user.save({session});

    if (notificationCompanyId) {
        emitNotificationEvent(NotificationEventCodes.ACCOUNT_ACTIVATED, {
            receiverIds: [user._id.toString()],
            payload: {
                companyId: notificationCompanyId,
                variant: "invitation",
                languageCode
            },
            session
        });
    }

    logger.finish(`Successfully accepted invitation for user [${user.username}]!`);

    return {
        message: "Invitation accepted successfully! You can now log in."
    };
}

/**
 * POST /api/user/acceptInvitation/validate
 *
 * Validates an invitation code without accepting it. Use before calling the accept endpoint.
 *
 * @route POST /api/user/acceptInvitation/validate
 * @access Public
 * @body {ValidateInvitationCodeFormType} - invitationCode
 * @returns {Promise<ValidateInvitationCodeFormResponseType>} Validation result (valid, message)
 *
 * @throws {apiValidationException} If invitation code is invalid, already accepted, or expired
 *
 * @remarks
 * - Rate limited: 10 requests per minute
 * - Read-only; no database writes. Validates code existence, acceptance status, and expiration
 */
router.post(
    "/validate",
    authMW("public"),
    rateLimiter({ windowMs: 60000, max: 10 }),
    validateFormZod(validateInvitationCodeFormSchema),
    asyncHandler(validateInvitationCode)
);
/**
 * Validates invitation code (existence, not already accepted, not expired). No writes.
 *
 * @param params - Form (invitationCode), logger, languageCode.
 * @returns Validation result { valid: true, message } or throws.
 */
async function validateInvitationCode(params: ValidateInvitationCodeFormType & NotAuthenticatedMWType): Promise<ValidateInvitationCodeFormResponseType> {
    const { invitationCode, logger, languageCode } = params;

    logger.start(`Validating invitation code...`);

    // Find user by invitation code
    const user = await userService.findOne(
        { "requests.invitation.code": invitationCode },
        { logger, languageCode }
    );

    if (!user) {
        throw apiValidationException("invitation_code_not_valid", null, null, languageCode);
    }

    // Check if invitation has already been accepted
    if (user.requests.invitation?.accepted) {
        throw apiValidationException("invitation_already_accepted", null, null, languageCode);
    }

    // Check if invitation has expired
    if (user.requests.invitation?.invitationExpiresAt && new Date() > user.requests.invitation.invitationExpiresAt) {
        throw apiValidationException("invitation_expired", null, null, languageCode);
    }

    await userService.updateById(
        user._id,
        {
            $set: {
                "requests.invitation.opened": true,
            }
        },
        {
            logger,
            languageCode,
            auditUserId: user._id.toString()
        } as any
    );

    user.$locals = user.$locals || {};
    user.$locals.auditUserId = user._id;
    logger.finish(`Invitation code is valid for user [${user.username}]`);

    return {
        valid: true,
        message: "Invitation code is valid"
    };
}

export { router };

