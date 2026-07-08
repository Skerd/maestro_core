import qrcode from 'qrcode';
import {Router} from "express";
import speakeasy from "speakeasy";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import authMW, {AuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import {asyncHandler} from "@coreModule/utilities/middlewares/asyncHandler";
import {transactionHandler} from "@coreModule/utilities/middlewares/transactionHandler";
import {TransactionRequiredParams} from "@coreModule/utilities/middlewares/transactionUtils";
import {EnableMfaFormType} from "armonia/src/modules/core/api/user/private/mfa/enableMfa.form.type";
import {DeactivateMfaFormType} from "armonia/src/modules/core/api/user/private/mfa/deactivateMfa.form.type";
import {EnableMfaFormResponseType} from "armonia/src/modules/core/api/user/private/mfa/enableMfa.form.response.type";
import {
    DeactivateMfaFormResponseType
} from "armonia/src/modules/core/api/user/private/mfa/deactivateMfa.form.response.type";
import {MfaStatusFormResponseType} from "armonia/src/modules/core/api/user/private/mfa/mfaStatus.form.response.type";
import {
    GenerateMfaQrCodeFormResponseType
} from "armonia/src/modules/core/api/user/private/mfa/generateMfaQrCode.form.response.type";
import {enableMfaFormSchema} from "armonia/src/modules/core/api/user/private/mfa/enableMfa.form.validator";
import {deactivateMfaFormSchema} from "armonia/src/modules/core/api/user/private/mfa/deactivateMfa.form.validator";
import {companyService} from "@coreModule/database/schemas/company/company.service";
import {userService} from "@coreModule/database/schemas/user/user.service";
import SchemaGuard from "@coreModule/database/security/schemaGuard";
import User from "@coreModule/database/schemas/user/user";
import {ObjectId} from "mongodb";
import {rateLimiter} from "@coreModule/utilities/middlewares/rateLimiter";
import {validateFormZod} from "@coreModule/utilities/middlewares/validateFormZod";
import {emitNotificationEvent, NotificationEventCodes} from "@coreModule/domain/notifications/notificationEventBus";

/**
 * User MFA API – private endpoints for managing multi-factor authentication.
 *
 * Mounted under the user private routes (e.g. `/api/user/mfa`). All endpoints require
 * authentication. Field-level access is enforced via SchemaGuard. MFA operations are audited.
 *
 * **Routes:**
 * - `GET ""` – MFA status (enabled boolean).
 * - `POST ""` – Generate QR code for MFA setup; stores secret temporarily until user verifies.
 * - `PUT ""` – Enable MFA after verifying token from authenticator app.
 * - `DELETE ""` – Disable MFA (parental bypass, email deactivation code, or MFA code verification).
 *
 * @module f_endpoints/core/user/private/mfa
 */

const router = Router();

/**
 * GET /api/user/mfa
 *
 * Returns whether MFA is currently enabled for the authenticated user. Field-level read access for mfaStatus enforced via SchemaGuard.
 *
 * @route GET /api/user/mfa
 * @access Private
 * @returns Promise<MfaStatusFormResponseType> – { enabled: boolean }
 *
 * @remarks
 * - Rate limited: 60 requests per minute
 */
router.get(
    "",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 60}),
    asyncHandler(MFAStatus)
);
/**
 * Returns MFA enabled status for the authenticated user. Respects SchemaGuard for mfaSecret read access.
 *
 * @param params - Authenticated middleware parameters (logger, userInfo, actionUserCtx, languageCode).
 * @returns MFA enabled status { enabled: boolean }.
 */
async function MFAStatus(params: AuthenticatedMWType): Promise<MfaStatusFormResponseType> {
    const { logger, userInfo, actionUserCtx, languageCode } = params;
    
    logger.start("Serving account mfa status...");
    SchemaGuard.sanitizeFields(User, {mfaStatus: {}}, "read", actionUserCtx, languageCode);
    logger.finish("Finished serving account mfa status!");
    return {
        enabled: userInfo.isMfaEnabled()
    };
}

/**
 * POST /api/user/mfa
 *
 * Generates a QR code for MFA setup and stores the secret in requests.mfaActivation.secret until the user verifies via PUT. If MFA is already enabled, returns empty secret and data_url.
 *
 * @route POST /api/user/mfa
 * @access Private
 * @returns Promise<GenerateMfaQrCodeFormResponseType> – secret, data_url, enabled
 *
 * @remarks
 * - Requires transaction and write permission for mfaStatus
 * - QR code issuer: first company name (user must have at least one company)
 * - Rate limited: 10 requests per minute
 */
router.post(
    "",
    authMW("private"),
    rateLimiter({ windowMs: 60000, max: 10 }),
    transactionHandler(),
    asyncHandler(generateMFAQrCode)
);
/**
 * Generates QR code for MFA setup and stores the secret in requests.mfaActivation until the user verifies. Uses first company name as issuer.
 *
 * @param params - Transaction and authenticated parameters (logger, userInfo, session, languageCode, actionUserCtx).
 * @returns QR code data URL and secret for the authenticator app; empty if MFA already enabled.
 */
async function generateMFAQrCode(params: TransactionRequiredParams & AuthenticatedMWType): Promise<GenerateMfaQrCodeFormResponseType> {
    const { logger, userInfo, session, languageCode, actionUserCtx } = params;

    logger.start(`Trying to generate mfa qr code...`);
    SchemaGuard.sanitizeFields(User, {mfaStatus: {}}, "write", actionUserCtx, languageCode);
    // Check if MFA is already enabled
    if (userInfo.isMfaEnabled()) {
        logger.finish("MFA already activated!");
        return {
            secret: "",
            data_url: "",
            enabled: true
        };
    }

    // Get the first company for issuer (assuming user has at least one company)
    const companyIds = userInfo.companies.map((c: any) => c._id || c);
    const company = await companyService.findOneOrThrow(
        { _id: { $in: companyIds } },
        { session, logger, languageCode }
    );

    // Generate secret
    const secret = speakeasy.generateSecret();
    const otpauthUrl = speakeasy.otpauthURL({
        secret: secret.ascii,
        label: userInfo.username,
        issuer: company.name
    });

    // Generate QR code data URL (qrcode returns a Promise when no callback is passed)
    const data_url = await qrcode.toDataURL(otpauthUrl);

    // Store the secret temporarily (will be activated when user verifies)
    await userService.updateByIdOrThrow(
        userInfo._id,
        { $set: { "requests.mfaActivation.secret": secret.ascii } },
        { session, logger, languageCode, auditUserId: actionUserCtx.userId }
    );

    logger.finish(`Generated mfa qr code!`);

    return {
        secret: secret.ascii,
        data_url: data_url,
        enabled: false
    };
}

/**
 * PUT /api/user/mfa
 *
 * Enables MFA after verifying the token from the authenticator app. Requires a prior POST (QR generation) so that requests.mfaActivation.secret is set. Resets unsuccessful login attempts on success.
 *
 * @route PUT /api/user/mfa
 * @access Private
 * @body {EnableMfaFormType} - token, secret (must match stored activation secret)
 * @returns Promise<EnableMfaFormResponseType> – success message
 *
 * @throws apiValidationException if MFA already enabled, activation request not made, or token verification fails
 *
 * @remarks
 * - Requires transaction and write permission for mfaStatus
 * - Rate limited: 10 requests per minute
 */
router.put(
    "",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 10}),
    validateFormZod(enableMfaFormSchema),
    transactionHandler(),
    asyncHandler(enableMFA)
);
/**
 * Enables MFA after verifying the token against the stored activation secret. Persists the provided secret and resets unsuccessful logins for the company.
 *
 * @param params - Transaction, form (token, secret), and authenticated parameters (userInfo, session, company, actionUserCtx, etc.).
 * @returns Success message.
 */
async function enableMFA(params: TransactionRequiredParams & EnableMfaFormType & AuthenticatedMWType): Promise<EnableMfaFormResponseType> {
    const { token, secret, languageCode, logger, userInfo, session, parentBypass, company, actionUserCtx } = params;

    logger.start(`Trying to enable mfa...`);
    SchemaGuard.sanitizeFields(User, {mfaStatus: {}}, "write", actionUserCtx, languageCode);

    // Check if MFA is already enabled
    if (userInfo.isMfaEnabled()) {
        throw apiValidationException("mfa_already_enabled", null, null, languageCode);
    }

    // Verify that QR code generation step was completed
    if (!userInfo.requests.mfaActivation.secret || userInfo.requests.mfaActivation.secret === "") {
        throw apiValidationException("mfa_activation_request_not_made", null, null, languageCode);
    }

    // Verify the token from the authenticator app
    if (!userInfo.verifyRequestMfa(token)) {
        logger.err(`MFA failed to be enabled - invalid token`);
        // Don't reset the secret, user might have made a typo
        throw apiValidationException("cannot_enable_mfa_wrong_code", null, null, languageCode);
    }

    // Enable MFA by storing the secret
    userInfo.mfaSecret = secret;
    userInfo.mfaStatus = "active";
    userInfo.$locals = userInfo.$locals || {};
    userInfo.$locals.auditUserId = new ObjectId(actionUserCtx.userId);
    await userInfo.save({session});

    // Reset unsuccessful login attempts on successful MFA setup
    await userInfo.resetUnsuccessfulLogins(company._id, session);

    emitNotificationEvent(
        NotificationEventCodes.MFA_ENABLED, 
        {
            receiverIds: [userInfo._id.toString()],
            payload: {
                companyId: company._id.toString(),
                languageCode
            },
            session
        }
    );

    logger.finish(`MFA enabled!`);

    return {
        message: "MFA successfully enabled"
    };
}

/**
 * DELETE /api/user/mfa
 *
 * Disables MFA via one of three paths: parental bypass (admin, no verification), email (sends deactivation code; does not disable immediately), or MFA code verification from the authenticator app.
 *
 * @route DELETE /api/user/mfa
 * @access Private
 * @body {DeactivateMfaFormType} - mfaCode?, sendEmail?, parentBypass?
 * @returns Promise<DeactivateMfaFormResponseType> – sentEmail, disabledMfa
 *
 * @throws apiValidationException if MFA not enabled (code path), code invalid, or invalid deactivation request
 *
 * @remarks
 * - Requires transaction; all paths respect SchemaGuard and audit
 * - Rate limited: 10 requests per minute
 */
router.delete(
    "",
    authMW("private"),
    rateLimiter({
        windowMs: 60000,
        max: 10
    }),
    validateFormZod(deactivateMfaFormSchema),
    transactionHandler(),
    asyncHandler(disableMFA)
);
/**
 * Disables MFA by parental bypass, email (send deactivation code), or MFA code verification. Updates mfaSecret and audits the action.
 *
 * @param params - Transaction, form (mfaCode, sendEmail, parentBypass), and authenticated parameters (userInfo, session, company, actionUserCtx, etc.).
 * @returns Deactivation result { sentEmail, disabledMfa }.
 */
async function disableMFA(params: TransactionRequiredParams & DeactivateMfaFormType & AuthenticatedMWType): Promise<DeactivateMfaFormResponseType> {
    const { mfaCode, sendEmail, languageCode, logger, userInfo, session, parentBypass, company, actionUserCtx } = params;

    logger.start(`Trying to disable account mfa...`);

    // Parental bypass path
    if (parentBypass) {
        await userService.updateByIdOrThrow(
            userInfo._id,
            { $set: { mfaSecret: "", mfaStatus: "notActive" } },
            { session, logger, languageCode, auditUserId: actionUserCtx.userId }
        );

        emitNotificationEvent(
            NotificationEventCodes.MFA_DISABLED,
            {
                receiverIds: [userInfo._id.toString()],
                payload: {
                    companyId: company._id.toString(),
                    languageCode
                },
                session
            }
        );
        
        logger.finish(`Disabled mfa using parental override!`);
        
        return {
            sentEmail: false,
            disabledMfa: true
        };
    }

    // Email-based deactivation path
    if (sendEmail) {
        await userInfo.sendDisableMfaEmail(languageCode, session);
        
        logger.finish(`Successfully created user mfa deactivation code and sent to email!`);
        
        return {
            sentEmail: true,
            disabledMfa: false
        };
    }

    // Direct MFA code verification path
    if (mfaCode && mfaCode !== "") {
        if (!userInfo.isMfaEnabled()) {
            throw apiValidationException("mfa_not_enabled", null, null, languageCode);
        }

        await userInfo.verifyMfa(company._id, mfaCode, languageCode);

        await userService.updateByIdOrThrow(
            userInfo._id,
            { $set: { mfaSecret: "", mfaStatus: "notActive", "requests.mfaDeactivation.code": "", "requests.mfaActivation.secret": "" } },
            { session, logger, languageCode, auditUserId: actionUserCtx.userId }
        );

        emitNotificationEvent(
            NotificationEventCodes.MFA_DISABLED, 
            {
                receiverIds: [userInfo._id.toString()],
                payload: {
                    companyId: company._id.toString(),
                    languageCode
                },
                session
            }
        );

        logger.finish(`Disabled mfa using MFA code provided from authenticator app!`);
        
        return {
            sentEmail: false,
            disabledMfa: true
        };
    }

    // If none of the paths match, this shouldn't happen due to validation
    throw apiValidationException("invalid_mfa_deactivation_request", null, null, languageCode);
}

export { router };
