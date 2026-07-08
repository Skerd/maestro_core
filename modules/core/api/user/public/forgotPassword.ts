/**
 * Forgot password API – public endpoints for password reset (request reset, open link, change password).
 *
 * Mounted under the user public routes (e.g. `/api/user/forgotPassword`). Endpoints are public
 * (no authentication required) for users who have forgotten their passwords. Request sends a
 * reset code by email; openLink validates the code and can mark the link as opened (single-use);
 * changePassword sets the new password and clears reset request. Changes are audited with the
 * user's own ID (self-action).
 *
 * **Routes:**
 * - `POST ""` – Request password reset; send reset code to user's email.
 * - `POST "/openLink"` – Open reset link: validate code and (optionally) mark as opened; 24h expiry.
 * - `POST "/changePassword"` – Set new password with reset code and clear reset request.
 *
 * @module f_endpoints/core/user/public/forgotPassword
 */

import {Router} from "express";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {asyncHandler} from "@coreModule/utilities/middlewares/asyncHandler";
import authMW, {NotAuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import {ForgotPasswordFormType} from "armonia/src/modules/core/api/user/public/forgotPassword/forgotPassword.form.type";
import {
    OpenForgotPasswordLinkFormType
} from "armonia/src/modules/core/api/user/public/forgotPassword/openForgotPasswordLink.form.type";
import {
    ForgotPasswordFormResponseType
} from "armonia/src/modules/core/api/user/public/forgotPassword/forgotPassword.form.response.type";
import {
    ChangeForgottenPasswordFormType
} from "armonia/src/modules/core/api/user/public/forgotPassword/changeForgottenPassword.form.type";
import {
    forgotPasswordFormSchema
} from "armonia/src/modules/core/api/user/public/forgotPassword/forgotPassword.form.validator";
import {
    OpenForgotPasswordLinkFormResponseType
} from "armonia/src/modules/core/api/user/public/forgotPassword/openForgotPasswordLink.form.response.type";
import {
    openForgotPasswordLinkFormSchema
} from "armonia/src/modules/core/api/user/public/forgotPassword/openForgotPasswordLink.form.validator";
import {
    ChangeForgottenPasswordFormResponseType
} from "armonia/src/modules/core/api/user/public/forgotPassword/changeForgottenPassword.form.response.type";
import {
    changeForgottenPasswordFormSchema
} from "armonia/src/modules/core/api/user/public/forgotPassword/changeForgottenPassword.form.validator";
import {userService} from "@coreModule/database/schemas/user/user.service";
import {transactionHandler} from "@coreModule/utilities/middlewares/transactionHandler";
import {TransactionRequiredParams} from "@coreModule/utilities/middlewares/transactionUtils";
import {AUTHENTICATION} from "@coreModule/environment";
import {rateLimiter} from "@coreModule/utilities/middlewares/rateLimiter";
import {validateFormZod} from "@coreModule/utilities/middlewares/validateFormZod";

const router = Router();

/**
 * POST /api/user/forgotPassword
 *
 * Initiates password reset by sending a reset code to the user's email.
 *
 * @route POST /api/user/forgotPassword
 * @access Public
 * @requires Transaction
 * @body {ForgotPasswordFormType} - email
 * @returns {Promise<ForgotPasswordFormResponseType>} Success message
 *
 * @throws {apiValidationException} If user with email not found
 *
 * @remarks
 * - Rate limited: 5 requests per minute
 * - Sends reset email and updates password reset request fields; audited with user's own ID (self-action)
 */
router.post(
    "",
    authMW("public"),
    rateLimiter({ windowMs: 60000, max: 5 }),
    validateFormZod(forgotPasswordFormSchema),
    transactionHandler(),
    asyncHandler(ForgotPassword)
);
/**
 * Sends password reset email with code and updates reset request fields. Uses user's own ID for audit.
 *
 * @param params - Transaction, form (email), logger, languageCode, session.
 * @returns Success message.
 */
async function ForgotPassword(params: TransactionRequiredParams & ForgotPasswordFormType & NotAuthenticatedMWType): Promise<ForgotPasswordFormResponseType> {

    let {email, languageCode, logger, session} = params;

    logger.start(`Trying to create reset code for forgotten password for user with email [${email}]...`);

    let user = await userService.findOneOrThrow(
        {username: email},
        {session, logger, languageCode}
    );

    if( !Object.keys(user?.requests?.passwordReset || {}).length ){
        let now = new Date();
        await userService.updateOne(
            {_id: user._id},
            {
                $set: {
                    "requests.passwordReset": {
                        date: now,
                    }
                }
            },
            {session, logger, languageCode}
        )
        user = await userService.findOneOrThrow(
            {username: email},
            {session, logger, languageCode}
        );
    }

    // Set auditUserId for self-action (user requesting password reset for their own account)
    user.$locals = user.$locals || {};
    user.$locals.auditUserId = user._id;
    await user.sendForgotPasswordEmail(languageCode, session, logger);

    logger.finish(`Successfully created user reset password code for forgotten password for user with email / id: [${email} / ${user._id}]!`);

    return {
        message: "User password link generated successfully"
    }
}

/**
 * POST /api/user/forgotPassword/openLink
 *
 * Opens the password reset link: validates reset code and (if configured) marks link as opened.
 * Link expires after 24 hours; can be single-use depending on security setting.
 *
 * @route POST /api/user/forgotPassword/openLink
 * @access Public
 * @requires Transaction
 * @body {OpenForgotPasswordLinkFormType} - resetPasswordCode
 * @returns {Promise<OpenForgotPasswordLinkFormResponseType>} Success message
 *
 * @throws {apiValidationException} If reset code invalid, link already consumed, or link expired (24h)
 *
 * @remarks
 * - Rate limited: 10 requests per minute
 * - Validates code and 24h expiration; optionally marks as opened (single-use); audited with user's ID
 */
router.post(
    "/openLink",
    authMW("public"),
    rateLimiter({ windowMs: 60000, max: 10 }),
    validateFormZod(openForgotPasswordLinkFormSchema),
    transactionHandler(),
    asyncHandler(ForgotPasswordOpenLink)
);
/**
 * Validates reset code and 24h expiry; marks link as opened if single-use is enabled. Uses user's ID for audit.
 *
 * @param params - Transaction, form (resetPasswordCode), logger, languageCode, session.
 * @returns Success message.
 */
async function ForgotPasswordOpenLink(params: TransactionRequiredParams & OpenForgotPasswordLinkFormType & NotAuthenticatedMWType): Promise<OpenForgotPasswordLinkFormResponseType> {

    let {resetPasswordCode, languageCode, logger, session} = params;

    logger.start(`Trying to open link for reset code for user with reset password code [${resetPasswordCode}]...`);

    let resetPasswordUser = await userService.findOne({"requests.passwordReset.code": resetPasswordCode}, {session, logger, languageCode});
    if (!resetPasswordUser) {
        throw apiValidationException("reset_password_code_not_valid", null, null, languageCode);
    }

    if( resetPasswordUser.requests.passwordReset.opened ){
        await userService.updateOne({_id: resetPasswordUser._id}, {
            $unset: {
                "requests.passwordReset": "",
            }
        }, { session: null, logger, languageCode, auditUserId: resetPasswordUser._id.toString() });
        throw apiValidationException("reset_password_link_already_consumed", null, null, languageCode);
    }

    const dateNow = new Date();
    const resetPasswordDate = resetPasswordUser.requests.passwordReset.date;
    // @ts-ignore
    let diff = dateNow - resetPasswordDate;
    if( diff > (24 * 60 * 60 * 1000) ){
        throw apiValidationException("reset_password_link_expired", null, null, languageCode);
    }

    // if the security setting is set to true, the reset password link can only be opened once
    await userService.updateOne({_id: resetPasswordUser._id}, {
        $set: {
            "requests.passwordReset.opened": AUTHENTICATION.PASSWORD_RESET_EXPIRE_AFTER_OPEN,
        }
    }, { session, logger, languageCode, auditUserId: resetPasswordUser._id.toString() });

    logger.finish(`Successfully opened reset link for user with email / id: [${resetPasswordUser.username} / ${resetPasswordUser._id}]!`);

    return {
        message: "User password reset link opened successfully!"
    }

}

/**
 * POST /api/user/forgotPassword/changePassword
 *
 * Changes user password using a valid reset code. Clears reset request fields after success.
 *
 * @route POST /api/user/forgotPassword/changePassword
 * @access Public
 * @requires Transaction
 * @body {ChangeForgottenPasswordFormType} - resetPasswordCode, password
 * @returns {Promise<ChangeForgottenPasswordFormResponseType>} Success message
 *
 * @throws {apiValidationException} If reset code is invalid
 *
 * @remarks
 * - Rate limited: 2 requests per minute
 * - Validates code, sets password (hashed by pre-save), clears reset request; audited with user's ID (self-action)
 */
router.post(
    "/changePassword",
    authMW("public"),
    rateLimiter({ windowMs: 60000, max: 2 }),
    validateFormZod(changeForgottenPasswordFormSchema),
    transactionHandler(),
    asyncHandler(ForgotPasswordChangePassword)
);
/**
 * Validates reset code, sets new password (hashed by pre-save), clears reset request. Uses user's ID for audit.
 *
 * @param params - Transaction, form (resetPasswordCode, password), logger, languageCode, session.
 * @returns Success message.
 */
async function ForgotPasswordChangePassword(params: TransactionRequiredParams & ChangeForgottenPasswordFormType & NotAuthenticatedMWType): Promise<ChangeForgottenPasswordFormResponseType> {

    let {resetPasswordCode, password, languageCode, logger, session} = params;

    logger.start(`Trying to change password for user with reset password code [${resetPasswordCode}]...`);

    let resetPasswordUser = await userService.findOne({"requests.passwordReset.code": resetPasswordCode}, {session, logger, languageCode});
    if (!resetPasswordUser?._id) {
        throw apiValidationException("reset_password_code_not_valid", null, null, languageCode);
    }

    await userService.updateByIdOrThrow(
        resetPasswordUser._id,
        {
            $unset: {
                "requests.passwordReset": "",
            }
        },
        { session, logger, languageCode, auditUserId: resetPasswordUser._id.toString() }
    );

    resetPasswordUser.password = password;
    resetPasswordUser.$locals = resetPasswordUser.$locals || {};
    resetPasswordUser.$locals.auditUserId = resetPasswordUser._id;
    await resetPasswordUser.save({session});

    logger.finish(`Successfully changed password for user with email / id: [${resetPasswordUser.username} / ${resetPasswordUser._id}]!`);

    return {
        message: "User password successfully changed"
    }
}

const functions = {}
module.exports = {router, functions};
