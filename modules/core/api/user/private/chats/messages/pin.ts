import {Router} from "express";
import {ObjectId} from "mongodb";
import {asyncHandler} from "@coreModule/utilities/middlewares/asyncHandler";
import {validateFormZod} from "@coreModule/utilities/middlewares/validateFormZod";
import {transactionHandler} from "@coreModule/utilities/middlewares/transactionHandler";
import {TransactionRequired} from "@coreModule/utilities/middlewares/transactionUtils";
import authMW, {AuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {WebSocketMessage, WebSocketMessageCodes} from "armonia/src/modules/core/websocket/types";
import {pushWebsocketMessage} from "@coreModule/domain/websocket/pushWebsocketMessage";
import {
    GetMessageSingleFormType
} from "armonia/src/modules/core/api/user/private/chats/messages/getMessageSingle.form.type";
import {
    getMessageSingleFormSchema
} from "armonia/src/modules/core/api/user/private/chats/messages/getMessageSingle.form.validator";
import {
    GetMessagePinSingleFormResponseType
} from "armonia/src/modules/core/api/user/private/chats/messages/getMessagePinSingle.form.response.type";
import {loadMessageAndChannelForReadAccess} from "@coreModule/utilities/endpoints/messageChannelReadAccess";
import {messagePinToDTO} from "@coreModule/utilities/mappers/message/messagePinMapper.dto";
import {channelService} from "@coreModule/database/schemas/channel/channel.service";
import {messageService} from "@coreModule/database/schemas/message/message.service";
import Message from "@coreModule/database/schemas/message/message";
import {
    PinMessageFormType
} from "armonia/src/modules/core/api/user/private/chats/messages/actions/pinMessage.form.type";
import {
    pinMessageFormSchema
} from "armonia/src/modules/core/api/user/private/chats/messages/actions/pinMessage.form.validator";
import {
    PinMessageFormResponseType
} from "armonia/src/modules/core/api/user/private/chats/messages/actions/pinMessage.form.response.type";
import SchemaGuard from "@coreModule/database/security/schemaGuard";
import {rateLimiter} from "@coreModule/utilities/middlewares/rateLimiter";
import {
    UnpinMessageFormType
} from "armonia/src/modules/core/api/user/private/chats/messages/actions/unpinMessage.form.type";
import {
    unpinMessageFormSchema
} from "armonia/src/modules/core/api/user/private/chats/messages/actions/unpinMessage.form.validator";
import {
    UnpinMessageFormResponseType
} from "armonia/src/modules/core/api/user/private/chats/messages/actions/unpinMessage.form.response.type";

/**
 * Message pin API – private endpoints for pinning/unpinning chat messages.
 *
 * Mounted under the user private chat routes (e.g. `/user/chats/messages/pin`). All endpoints
 * require authentication and channel membership. Field-level access enforced via SchemaGuard.
 *
 * **Routes:**
 * - `POST "/single"` – Pin metadata for one message (same visibility as message single).
 * - `PUT ""` – Pin a message (max 10 per channel).
 * - `DELETE ""` – Unpin a message.
 *
 * @module f_endpoints/core/user/private/chats/messages/pin
 */

const router = Router();

/**
 * POST /api/user/chats/messages/pin/single
 *
 * Returns pin metadata for a message the caller can read. Clients should call this after a
 * `MESSAGE_PINNED` WebSocket event (payload: `channelId`, `messageId`).
 */
router.post(
    "/single",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 60}),
    validateFormZod(getMessageSingleFormSchema),
    asyncHandler(getPinSingle)
);
type GetPinSingleType = AuthenticatedMWType & GetMessageSingleFormType;

async function getPinSingle(params: GetPinSingleType): Promise<GetMessagePinSingleFormResponseType> {
    const {messageId, languageCode, logger, userInfo, company, actionUserCtx} = params;

    logger.start(`Fetching pin state for message ${messageId}...`);
    await loadMessageAndChannelForReadAccess(messageId, userInfo, company, languageCode, logger);

    const sanitizedFields = SchemaGuard.sanitizeFields(
        Message,
        {pinned: {keys: {date: {}, user: {keys: {name: {}, surname: {}, fullName: {}, photo: {}}}}}},
        "read",
        actionUserCtx,
        languageCode
    );
    const populate = SchemaGuard.generatePopulate(sanitizedFields, Message.schema);
    const modifiedMessage = await messageService.findByIdOrThrow(
        new ObjectId(messageId),
        {logger, languageCode},
        populate.populate,
        populate.select
    );

    logger.finish(`Fetched pin state for message ${messageId}`);
    return messagePinToDTO(modifiedMessage);
}

/**
 * PUT /api/user/chats/messages/pin
 *
 * Pins a message in a chat channel (max 10 pinned messages per channel).
 * Only channel owners/admins can pin messages.
 *
 * @route PUT /api/user/chats/messages/pin
 * @access Private
 * @requires Transaction
 * @body {PinMessageFormType} - messageId
 * @returns {Promise<PinMessageFormResponseType>} pinned info (date + user summary)
 *
 * @throws {apiValidationException} If message not found, deleted, or user is not owner/admin
 * @throws {apiValidationException} If max pinned messages per channel is reached
 *
 * @remarks
 * - Rate limited: 60 requests per minute
 * - Requires write access to Message.pinned via SchemaGuard
 * - Updates message.pinned and channel.pinnedMessages (audited)
 * - Emits `MESSAGE_PINNED` WebSocket (`pushWebsocketMessage`): `{ channelId, messageId }` to other channel members (refetch `POST .../pin/single`)
 */
router.put(
    "",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 60}),
    validateFormZod(pinMessageFormSchema),
    transactionHandler(),
    asyncHandler(pinMessage)
);
/**
 * Pins a message in a chat channel.
 * 
 * @param params - Transaction, form, and authenticated parameters
 * @returns Pinned message information with date and user details
 */
async function pinMessage(params: TransactionRequired & PinMessageFormType & AuthenticatedMWType): Promise<PinMessageFormResponseType> {
    const { messageId, languageCode, logger, userInfo, company, session, actionUserCtx, actionUserInfo } = params;

    logger.start(`Pinning message ${messageId} by user ${userInfo._id.toString()}...`);
    SchemaGuard.sanitizeFields(Message, {pinned: {}}, "write", actionUserCtx, languageCode);

    const message = await messageService.findOneOrThrow(
        {
            _id: new ObjectId(messageId),
            status: { $ne: "deleted" }
        },
        { session, logger, languageCode }
    );

    const messageChannel = await channelService.findOneOrThrow(
        {
            _id: message.channel._id,
            company: company._id,
            deleted: false,
            users: userInfo._id,
            adminUsers: userInfo._id
        },
        { session, logger, languageCode },
        null,
        null,
        apiValidationException("you_must_be_owner_or_admin_to_pin_messages", null, null, languageCode)
    )

    const currentPinnedCount = (messageChannel.pinnedMessages || []).length;
    if (currentPinnedCount >= 10 && !message.pinned) {
        logger.debug(`Channel already has ${currentPinnedCount} pinned messages (max 10)`);
        throw apiValidationException("max_pinned_messages_reached", null, null, languageCode);
    }

    await messageService.updateById(
        message._id,
        {
            pinned: {
                date: new Date(),
                user: userInfo._id
            }
        },
        { session, logger, languageCode, auditUserId: actionUserCtx.userId }
    );

    await channelService.updateById(
        messageChannel._id,
        {
            $addToSet: {
                pinnedMessages: message._id
            }
        },
        { session, logger, languageCode, auditUserId: actionUserCtx.userId }
    );

    let returnThis: PinMessageFormResponseType = null;
    // until here, we did everything needed to pin the message.
    try{
        let sanitizedFields = SchemaGuard.sanitizeFields(Message, {pinned: {keys: {date: {}, user: {keys: {name: {}, surname: {}, fullName: {}, photo: {}}}}}}, "read", actionUserCtx, languageCode);
        let populate = SchemaGuard.generatePopulate(sanitizedFields, Message.schema);
        let modifiedMessage = await messageService.findByIdOrThrow(
            message._id,
            { session, logger, languageCode },
            populate.populate,
            populate.select
        );
        returnThis = messagePinToDTO(modifiedMessage) ?? null;
    }catch (e){}

    try {
        const userIds = (messageChannel.users).map((u) => u._id.toString()).filter((id) => id !== actionUserInfo._id.toString());
        const websocketMessage: WebSocketMessage<{channelId: string; messageId: string}> = {
            code: WebSocketMessageCodes.MESSAGE_PINNED,
            payload: {
                channelId: messageChannel._id.toString(),
                messageId: message._id.toString()
            },
            userIds
        };
        pushWebsocketMessage(websocketMessage);
    } catch (e) {
        logger.debug(`Failed to send WebSocket notification: ${e}`);
    }

    return returnThis;

}

/**
 * DELETE /api/user/chats/messages/pin
 *
 * Unpins a message from a chat channel. Owners, admins, or the original pinner can unpin.
 *
 * @route DELETE /api/user/chats/messages/pin
 * @access Private
 * @requires Transaction
 * @body {PinMessageFormType} - messageId
 * @returns {Promise<UnpinMessageFormResponseType>} Success message
 *
 * @throws {apiValidationException} If message not found or user not authorized to unpin
 *
 * @remarks
 * - Rate limited: 60 requests per minute
 * - Requires write access to Message.pinned via SchemaGuard
 * - Removes message.pinned and channel.pinnedMessages (audited)
 * - Emits `MESSAGE_PINNED` WebSocket with `{ channelId, messageId }` (same as pin; refetch `POST .../pin/single` for `pinned: null`)
 */
router.delete(
    "",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 60}),
    validateFormZod(unpinMessageFormSchema),
    transactionHandler(),
    asyncHandler(unpinMessage)
);
/**
 * Unpins a message from a chat channel.
 * 
 * @param params - Transaction, form, and authenticated parameters
 * @returns Success message confirming the unpin operation
 */
async function unpinMessage(params: TransactionRequired & UnpinMessageFormType & AuthenticatedMWType): Promise<UnpinMessageFormResponseType> {
    const { messageId, languageCode, logger, userInfo, company, session, actionUserCtx, actionUserInfo } = params;

    logger.start(`Unpinning message ${messageId} by user ${userInfo._id.toString()}...`);
    SchemaGuard.sanitizeFields(Message, {pinned: {}}, "write", actionUserCtx, languageCode);

    const message = await messageService.findOneOrThrow(
        {
            _id: new ObjectId(messageId),
            status: { $ne: "deleted" }
        },
        { session, logger, languageCode }
    );

    const messageChannel = await channelService.findOneOrThrow(
        {
            _id: message.channel._id,
            company: company._id,
            deleted: false,
            users: userInfo._id,
            $or: [
                {
                    adminUsers: userInfo._id
                },
                {
                    "pinned.user": userInfo._id
                }
            ]
        },
        { session, logger, languageCode },
        null,
        null,
        apiValidationException("you_must_be_owner_or_admin_to_unpin_messages", null, null, languageCode)
    )

    await messageService.updateById(
        message._id,
        {
            $unset: { pinned: 1 }
        },
        { session, logger, languageCode, returnNew: true, auditUserId: actionUserCtx.userId }
    );

    await channelService.updateById(
        messageChannel._id,
        {
            $pull: {
                pinnedMessages: message._id
            }
        },
        { session, logger, languageCode, auditUserId: actionUserCtx.userId }
    );

    try {
        const userIds = (messageChannel.users).map((u) => u._id.toString()).filter((id) => id !== actionUserInfo._id.toString());
        const websocketMessage: WebSocketMessage<{channelId: string; messageId: string}> = {
            code: WebSocketMessageCodes.MESSAGE_UNPINNED,
            payload: {
                channelId: messageChannel._id.toString(),
                messageId: message._id.toString()
            },
            userIds
        };
        pushWebsocketMessage(websocketMessage);
    } catch (e) {
        logger.debug(`Failed to send WebSocket notification: ${e}`);
    }

    logger.finish(`Successfully unpinned message ${messageId}`);
    return {
        message: "Message successfully unpinned"
    };
}

export { router };