/**
 * Telegram integration API – private endpoints for managing Telegram bot linking with the user account.
 *
 * Mounted under the user private routes (e.g. `/user/telegram`). All endpoints require authentication.
 * Field-level access is enforced via SchemaGuard. Write operations (POST, DELETE) are audited.
 *
 * **Routes:**
 * - `GET ""` – Check whether Telegram is linked (enabled: true/false).
 * - `POST ""` – Generate QR code and verification link for linking the Telegram bot.
 * - `DELETE ""` – Unlink Telegram from the user account.
 *
 * @module f_endpoints/core/user/private/telegram
 */

import qrcode from 'qrcode';
import {Router} from "express";
import {generateRandomString} from "@coreModule/utilities/helpers";
import {asyncHandler} from "@coreModule/utilities/middlewares/asyncHandler";
import authMW, {AuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import {transactionHandler} from "@coreModule/utilities/middlewares/transactionHandler";
import {TransactionRequiredParams} from "@coreModule/utilities/middlewares/transactionUtils";
import {
    TelegramStatusFormResponseType
} from "armonia/src/modules/core/api/user/private/telegram/telegramStatus.form.response.type";
import {
    DeactivateTelegramFormResponseType
} from "armonia/src/modules/core/api/user/private/telegram/deactivateTelegram.form.response.type";
import {
    GenerateTelegramQrCodeFormResponseType
} from "armonia/src/modules/core/api/user/private/telegram/generateTelegramQrCode.form.response.type";
import {userService} from "@coreModule/database/schemas/user/user.service";
import {TELEGRAM} from "@coreModule/environment";
import SchemaGuard from "@coreModule/database/security/schemaGuard";
import User from "@coreModule/database/schemas/user/user";
import {rateLimiter} from "@coreModule/utilities/middlewares/rateLimiter";
import {emitNotificationEvent, NotificationEventCodes} from "@coreModule/domain/notifications/notificationEventBus";

const router = Router();

/**
 * GET /api/user/telegram
 *
 * Checks whether the authenticated user has Telegram linked to their account.
 *
 * @route GET /api/user/telegram
 * @access Private
 * @returns {Promise<TelegramStatusFormResponseType>} Telegram linking status (enabled: boolean)
 *
 * @remarks
 * - Rate limited: 60 requests per minute
 * - Returns enabled: true if user.telegram.chatId exists, false otherwise
 */
router.get(
    "",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 60}),
    asyncHandler(TelegramStatus)
);
/**
 * Checks Telegram linking status for the authenticated user.
 *
 * @param params - Auth context (logger, userInfo, actionUserCtx, languageCode).
 * @returns Object with enabled boolean indicating if Telegram is linked.
 */
async function TelegramStatus(params: AuthenticatedMWType): Promise<TelegramStatusFormResponseType> {
    const { logger, userInfo, actionUserCtx, languageCode } = params;
    
    logger.start("Serving telegram linked status...");
    SchemaGuard.sanitizeFields(User, {telegram: {}}, "read", actionUserCtx, languageCode);
    logger.finish("Finished serving telegram linked status!");
    return {
        enabled: !!userInfo?.telegram?.chatId
    };
}

/**
 * POST /api/user/telegram
 *
 * Generates a QR code and verification link for linking the Telegram bot to the user's account.
 * If Telegram is already linked, returns empty strings with enabled: true.
 *
 * @route POST /api/user/telegram
 * @access Private
 * @requires Transaction
 * @returns {Promise<GenerateTelegramQrCodeFormResponseType>} inviteUrl, data_url (QR as data URL), enabled
 *
 * @throws {Error} If QR code generation fails
 *
 * @remarks
 * - Rate limited: 60 requests per minute
 * - Stores verification code in user.requests.telegram.code for bot verification
 * - Changes are audited with actionUserCtx.userId as the actor
 */
router.post(
    "",
    authMW("private"),
    rateLimiter({ windowMs: 60000, max: 60 }),
    transactionHandler(),
    asyncHandler(generateTelegramQrCode)
);
/**
 * Generates QR code and verification link for Telegram bot integration.
 * Creates a 64-character code, deep link, and stores code in user.requests.telegram.code.
 *
 * @param params - Auth and transaction context (logger, userInfo, session, languageCode, actionUserCtx).
 * @returns inviteUrl, data_url (base64 QR image), and enabled status.
 */
async function generateTelegramQrCode(params: TransactionRequiredParams & AuthenticatedMWType): Promise<GenerateTelegramQrCodeFormResponseType> {
    const { logger, userInfo, session, languageCode, actionUserCtx } = params;

    logger.start(`Trying to generate telegram qr code...`);
    SchemaGuard.sanitizeFields(User, {telegram: {}}, "write", actionUserCtx, languageCode);

    // Check if Telegram is already linked
    if (userInfo?.telegram?.chatId) {
        logger.finish("Telegram already linked!");
        return {
            inviteUrl: "",
            data_url: "",
            enabled: true
        };
    }

    // Generate unique code for Telegram bot verification
    const randomString = generateRandomString(64);
    const inviteUrl = `https://t.me/${TELEGRAM.NAME}?start=${randomString}`;

    const data_url = await qrcode.toDataURL(inviteUrl);

    // Store the code temporarily (will be verified when user links via Telegram bot)
    await userService.updateByIdOrThrow(
        userInfo._id,
        { $set: { "requests.telegram.code": randomString } },
        { session, logger, languageCode, auditUserId: actionUserCtx.userId }
    );

    logger.finish(`Finished generating telegram qr code!`);

    return {
        inviteUrl: inviteUrl,
        data_url: data_url,
        enabled: false
    };
}

/**
 * DELETE /api/user/telegram
 *
 * Unlinks Telegram from the user's account by setting telegram.chatId to null.
 *
 * @route DELETE /api/user/telegram
 * @access Private
 * @requires Transaction
 * @returns {Promise<DeactivateTelegramFormResponseType>} Success message
 *
 * @remarks
 * - Rate limited: 60 requests per minute
 * - Changes are audited with actionUserCtx.userId as the actor
 */
router.delete(
    "",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 60}),
    transactionHandler(),
    asyncHandler(disableTelegram)
);
/**
 * Unlinks Telegram from the user's account by clearing telegram.chatId.
 *
 * @param params - Auth and transaction context (logger, userInfo, session, languageCode, actionUserCtx).
 * @returns Success message confirming Telegram has been disabled.
 */
async function disableTelegram(params: TransactionRequiredParams & AuthenticatedMWType): Promise<DeactivateTelegramFormResponseType> {
    const { logger, userInfo, session, languageCode, actionUserCtx, company } = params;
    
    logger.start(`Disabling telegram...`);
    SchemaGuard.sanitizeFields(User, {telegram: {}}, "write", actionUserCtx, languageCode);

    await userService.updateByIdOrThrow(
        userInfo._id,
        { $set: { "telegram.chatId": null } },
        { session, logger, languageCode, auditUserId: actionUserCtx.userId }
    );

    emitNotificationEvent(NotificationEventCodes.TELEGRAM_UNLINKED, {
        receiverIds: [userInfo._id.toString()],
        payload: {
            companyId: company._id.toString(),
            languageCode
        },
        session
    });

    logger.finish("Finished disabling telegram!");
    
    return {
        message: "Telegram successfully disabled!"
    };
}

/** Express router for user Telegram endpoints. Mount under a user-scoped path. */
export { router };
