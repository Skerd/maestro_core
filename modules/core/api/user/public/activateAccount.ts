/**
 * User account activation API – public endpoint for activating accounts with an email activation code.
 *
 * Mounted under the user public routes (e.g. `/api/user/activateAccount`). Public (no authentication
 * required) for users who have not yet activated their accounts. Validates the code, updates username
 * from activation request if email was changed, marks email verified, and clears activation request;
 * changes are audited with the user's own ID (self-action).
 *
 * **Routes:**
 * - `PUT ""` – Activate account with activation code; set email verified and clear activation request.
 *
 * @module f_endpoints/core/user/public/activateAccount
 */

import {Router} from "express";
import {asyncHandler} from "@coreModule/utilities/middlewares/asyncHandler";
import authMW, {NotAuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import {transactionHandler} from "@coreModule/utilities/middlewares/transactionHandler";
import {TransactionRequiredParams} from "@coreModule/utilities/middlewares/transactionUtils";
import {
    accountActivationFormSchema
} from "armonia/src/modules/core/api/user/public/activateAccount/activateAccount.form.validator";
import {userService} from "@coreModule/database/schemas/user/user.service";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {
    ActivateAccountFormType
} from "armonia/src/modules/core/api/user/public/activateAccount/activateAccount.form.type";
import {
    ActivateAccountFormResponseType
} from "armonia/src/modules/core/api/user/public/activateAccount/activateAccount.form.response.type";
import {rateLimiter} from "@coreModule/utilities/middlewares/rateLimiter";
import {validateFormZod} from "@coreModule/utilities/middlewares/validateFormZod";
import {emitNotificationEvent, NotificationEventCodes} from "@coreModule/domain/notifications/notificationEventBus";

const router = Router();

/**
 * PUT /api/user/activateAccount
 *
 * Activates a user account by validating the activation code sent via email. Updates username from
 * activation request if email was changed, marks email verified, and clears activation request.
 *
 * @route PUT /api/user/activateAccount
 * @access Public
 * @requires Transaction
 * @body {AccountActivationFormType} - code (activation code)
 * @returns {Promise<ActivateAccountFormResponseType>} Success message
 *
 * @throws {apiValidationException} If activation code is invalid
 *
 * @remarks
 * - Rate limited: 10 requests per minute
 * - Validates code, updates username from activation request if present, marks email verified
 * - Clears activation request fields; changes audited with user's own ID (self-action)
 */
router.put(
    "",
    authMW("public"),
    rateLimiter({
        windowMs: 60000,
        max: 10
    }),
    validateFormZod(accountActivationFormSchema),
    transactionHandler(),
    asyncHandler(ActivateAccount)
);
/**
 * Activates account: validates code, sets username from activation request if present, marks email
 * verified, clears activation request. Uses user's own ID for audit (self-action).
 *
 * @param params - Transaction, form (code), logger, languageCode, session.
 * @returns Success message.
 */
async function ActivateAccount(params: TransactionRequiredParams & ActivateAccountFormType & NotAuthenticatedMWType): Promise<ActivateAccountFormResponseType> {
    const { code, languageCode, logger, session } = params;

    logger.start(`Trying to activate user account with activation code [${code}]...`);

    // Find user by activation code using service
    const user = await userService.findOne(
        { "requests.activation.code": code },
        { session, logger, languageCode }
    );

    if( !user ){
        throw apiValidationException("activation_code_not_valid", null, null, languageCode)
    }

    await userService.updateByIdOrThrow(
        user._id,
        {
            $set: {
                username: user.requests?.activation?.email || user.username,
                isEmailVerified: true,
                emailVerifiedAt: new Date()
            },
            $unset: {
                "requests.activation": "",
            }
        },
        { session, logger, languageCode, auditUserId: user._id.toString() }
    );

    const companyRef = user.companies?.[0];
    const notificationCompanyId = companyRef
        ? String((companyRef as {_id?: unknown})._id ?? companyRef)
        : undefined;
    if (notificationCompanyId) {
        emitNotificationEvent(NotificationEventCodes.ACCOUNT_ACTIVATED, {
            receiverIds: [user._id.toString()],
            payload: {
                companyId: notificationCompanyId,
                variant: "email",
                languageCode
            },
            session
        });
    }

    logger.finish(
        `Successfully activated account for user with username / id: [${user.username} / ${user._id}]!`
    );

    return {
        message: "User account activated successfully!"
    };
}

export { router };
