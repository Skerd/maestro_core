/**
 * MFA deactivation API – public endpoints for requesting and confirming MFA deactivation via email.
 *
 * Mounted under the user public routes (e.g. `/api/user/mfa`). Endpoints are public (no authentication
 * required) for users who need to disable MFA but may have lost access to their authenticator app.
 * Request sends a deactivation code by email; deactivate validates the code (24h expiry) and clears
 * mfaSecret and deactivation request. Changes are audited with the user's own ID (self-action).
 *
 * **Routes:**
 * - `POST "/requestDeactivation"` – Request MFA deactivation; send deactivation code to user's email.
 * - `PUT "/deactivate"` – Confirm deactivation with code; disable MFA and clear deactivation request (24h expiry).
 *
 * @module f_endpoints/core/user/public/mfa
 */

import {Router} from "express";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {asyncHandler} from "@coreModule/utilities/middlewares/asyncHandler";
import {DisableMfaFormType} from "armonia/src/modules/core/api/user/public/mfa/disableMfa.form.type";
import authMW, {NotAuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import {ConfirmMfaDisableFormType} from "armonia/src/modules/core/api/user/public/mfa/confirmMfaDisable.form.type";
import {DisableMfaFormResponseType} from "armonia/src/modules/core/api/user/public/mfa/disableMfa.form.response.type";
import {disableMfaFormSchema} from "armonia/src/modules/core/api/user/public/mfa/disableMfa.form.validator";
import {
    ConfirmMfaDisableFormResponseType
} from "armonia/src/modules/core/api/user/public/mfa/confirmMfaDisable.form.response.type";
import {
    confirmMfaDisableFormSchema
} from "armonia/src/modules/core/api/user/public/mfa/confirmMfaDisable.form.validator";
import {transactionHandler} from "@coreModule/utilities/middlewares/transactionHandler";
import {TransactionRequiredParams} from "@coreModule/utilities/middlewares/transactionUtils";
import {userService} from "@coreModule/database/schemas/user/user.service";
import {rateLimiter} from "@coreModule/utilities/middlewares/rateLimiter";
import {validateFormZod} from "@coreModule/utilities/middlewares/validateFormZod";
import {emitNotificationEvent, NotificationEventCodes} from "@coreModule/domain/notifications/notificationEventBus";

const router = Router();

/**
 * POST /api/user/mfa/requestDeactivation
 *
 * Initiates MFA deactivation by sending a deactivation code to the user's email.
 *
 * @route POST /api/user/mfa/requestDeactivation
 * @access Public
 * @requires Transaction
 * @body {DisableMfaFormType} - username
 * @returns {Promise<DisableMfaFormResponseType>} Success message
 *
 * @throws {apiValidationException} If user not found
 *
 * @remarks
 * - Rate limited: 10 requests per minute
 * - Sends deactivation email and updates deactivation request fields; audited with user's own ID (self-action)
 */
router.post(
    "/requestDeactivation",
    authMW("public"),
    rateLimiter({ windowMs: 60000, max: 10 }),
    validateFormZod(disableMfaFormSchema),
    transactionHandler(),
    asyncHandler(RequestDeactivation)
);
/**
 * Sends MFA deactivation email with code and updates deactivation request fields. Uses user's own ID for audit.
 *
 * @param params - Transaction, form (username), logger, languageCode, session.
 * @returns Success message.
 */
async function RequestDeactivation(params: TransactionRequiredParams & DisableMfaFormType & NotAuthenticatedMWType): Promise<DisableMfaFormResponseType> {
    const { username, languageCode, logger, session } = params;

    logger.start(`Trying to create mfa deactivation code for user [${username}]...`);

    // Find user using service
    let user = await userService.findOneOrThrow({ username }, { session, logger, languageCode });

    if( !Object.keys(user?.requests?.mfaDeactivation || {}).length ){
        let now = new Date();
        await userService.updateOne(
            {_id: user._id},
            {
                $set: {
                    "requests.mfaDeactivation": {
                        "date": now,
                    }
                }
            },
            {session, logger, languageCode}
        )
        user = await userService.findByIdOrThrow(
            user._id,
            {session, logger, languageCode}
        );
    }


    // Set auditUserId for self-action (user requesting MFA deactivation for their own account)
    user.$locals = user.$locals || {};
    user.$locals.auditUserId = user._id;
    // Send email to user to disable MFA
    await user.sendDisableMfaEmail(languageCode, session, logger);

    logger.finish(`Successfully created user mfa deactivation code for user with username / id: [${user.username} / ${user._id}]!`);

    return {
        message: "User mfa deactivation link generated successfully"
    };
}

/**
 * PUT /api/user/mfa/deactivate
 *
 * Confirms MFA deactivation by validating the code from email. Disables MFA and clears deactivation request.
 *
 * @route PUT /api/user/mfa/deactivate
 * @access Public
 * @requires Transaction
 * @body {ConfirmMfaDisableFormType} - code (deactivation code)
 * @returns {Promise<ConfirmMfaDisableFormResponseType>} Success message
 *
 * @throws {apiValidationException} If deactivation code invalid, link already consumed, or link expired (24h)
 *
 * @remarks
 * - Rate limited: 10 requests per minute
 * - Validates code and 24h expiration; clears mfaSecret and deactivation request; audited with user's ID (self-action)
 */
router.put(
    "/deactivate",
    authMW("public"),
    rateLimiter({ windowMs: 60000, max: 10 }),
    validateFormZod(confirmMfaDisableFormSchema),
    transactionHandler(),
    asyncHandler(Deactivate)
);
/**
 * Validates deactivation code and 24h expiry, clears mfaSecret and deactivation request. Uses user's ID for audit.
 *
 * @param params - Transaction, form (code), logger, languageCode, session.
 * @returns Success message.
 */
async function Deactivate(params: TransactionRequiredParams & ConfirmMfaDisableFormType & NotAuthenticatedMWType): Promise<ConfirmMfaDisableFormResponseType> {
    const { code, languageCode, logger, session } = params;

    logger.start(`Trying to deactivate user mfa with mfa deactivation code [${code}]...`);

    // Find the user by MFA deactivation code
    const user = await userService.findOne(
        { "requests.mfaDeactivation.code": code },
        { session, logger, languageCode }
    );

    if (!user) {
        throw apiValidationException("mfa_deactivation_code_not_valid", null, null, languageCode);
    }

    // Check if the link has expired (24 hours)
    const dateNow = new Date();
    const mfaResetRequestDate = user.requests.mfaDeactivation.date;
    const diff = dateNow.getTime() - mfaResetRequestDate.getTime();

    if (diff > 24 * 60 * 60 * 1000) {
        throw apiValidationException(
            "mfa_deactivation_link_expired",
            null,
            null,
            languageCode
        );
    }

    // Disable MFA and mark the request as opened
    // Use user's own ID as actor for audit logging (self-action on public endpoint)
    await userService.updateByIdOrThrow(
        user._id,
        {
            $unset: {
                "requests.mfaDeactivation": "",
                mfaSecret: "",
                mfaStatus: "notActive"
            }
        },
        { session, logger, languageCode, auditUserId: user._id.toString() }
    );

    const companyRef = user.companies?.[0];
    const notificationCompanyId = companyRef
        ? String((companyRef as {_id?: unknown})._id ?? companyRef)
        : undefined;
    if (notificationCompanyId) {
        emitNotificationEvent(
            NotificationEventCodes.MFA_DISABLED, 
            {
                receiverIds: [user._id.toString()],
                payload: {
                    companyId: notificationCompanyId,
                    languageCode
                },
                session
            }
        );
    }

    logger.finish(
        `Successfully opened mfa deactivation link and disabled MFA for user with username / id: [${user.username} / ${user._id}]!`
    );

    return {
        message: "User mfa disabled successfully!"
    };
}

export { router };
