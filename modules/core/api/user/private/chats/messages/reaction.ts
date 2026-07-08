import {Router} from "express";
import {ObjectId} from "mongodb";
import {asyncHandler} from "@coreModule/utilities/middlewares/asyncHandler";
import {validateFormZod} from "@coreModule/utilities/middlewares/validateFormZod";
import {transactionHandler} from "@coreModule/utilities/middlewares/transactionHandler";
import {TransactionRequired} from "@coreModule/utilities/middlewares/transactionUtils";
import authMW, {AuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import {EncryptString} from "@coreModule/utilities/security/encryption";
import {WebSocketMessage, WebSocketMessageCodes} from "armonia/src/modules/core/websocket/types";
import {pushWebsocketMessage} from "@coreModule/domain/websocket/pushWebsocketMessage";
import {
    GetMessageSingleFormType
} from "armonia/src/modules/core/api/user/private/chats/messages/getMessageSingle.form.type";
import {
    getMessageSingleFormSchema
} from "armonia/src/modules/core/api/user/private/chats/messages/getMessageSingle.form.validator";
import {
    GetMessageReactionsSingleFormResponseType
} from "armonia/src/modules/core/api/user/private/chats/messages/getMessageReactionsSingle.form.response.type";
import {loadMessageAndChannelForReadAccess} from "@coreModule/utilities/endpoints/messageChannelReadAccess";
import {
    messageReactionsToDTO,
    messageReactionToDTO
} from "@coreModule/utilities/mappers/message/messageReactionMapper.dto";
import {channelService} from "@coreModule/database/schemas/channel/channel.service";
import {messageService} from "@coreModule/database/schemas/message/message.service";
import Message from "@coreModule/database/schemas/message/message";
import {
    AddReactionFormType
} from "armonia/src/modules/core/api/user/private/chats/messages/actions/addReaction.form.type";
import {
    addReactionFormSchema
} from "armonia/src/modules/core/api/user/private/chats/messages/actions/addReaction.form.validator";
import {
    AddReactionFormResponseType
} from "armonia/src/modules/core/api/user/private/chats/messages/actions/addReaction.form.response.type";
import {
    RemoveReactionFormType
} from "armonia/src/modules/core/api/user/private/chats/messages/actions/removeReaction.form.type";
import {
    removeReactionFormSchema
} from "armonia/src/modules/core/api/user/private/chats/messages/actions/removeReaction.form.validator";
import SchemaGuard from "@coreModule/database/security/schemaGuard";
import {
    RemoveReactionFormResponseType
} from "armonia/src/modules/core/api/user/private/chats/messages/actions/removeReaction.form.response.type";
import {rateLimiter} from "@coreModule/utilities/middlewares/rateLimiter";

/**
 * Message reaction API – private endpoints for adding/removing reactions.
 *
 * Mounted under the user private chat routes (e.g. `/user/chats/messages/reaction`). All endpoints
 * require authentication and channel membership. Field-level access enforced via SchemaGuard.
 *
 * **Routes:**
 * - `POST "/single"` – All reactions on one message (same visibility as message single).
 * - `PUT ""` – Add or replace an emoji reaction.
 * - `DELETE ""` – Remove the user's reaction.
 *
 * @module f_endpoints/core/user/private/chats/messages/reaction
 */

const router = Router();

/**
 * POST /api/user/chats/messages/reaction/single
 *
 * Returns decrypted reactions for a message. Use after `MESSAGE_REACTION` WebSocket (`channelId`, `messageId`).
 */
router.post(
    "/single",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 60}),
    validateFormZod(getMessageSingleFormSchema),
    asyncHandler(getReactionsSingle)
);
type GetReactionsSingleType = AuthenticatedMWType & GetMessageSingleFormType;

async function getReactionsSingle(params: GetReactionsSingleType): Promise<GetMessageReactionsSingleFormResponseType> {
    const {messageId, languageCode, logger, userInfo, company, actionUserCtx} = params;

    logger.start(`Fetching reactions for message ${messageId}...`);
    await loadMessageAndChannelForReadAccess(messageId, userInfo, company, languageCode, logger);

    const sanitizedFields = SchemaGuard.sanitizeFields(
        Message,
        {reactions: {keys: {emoji: {}, date: {}, user: {keys: {name: {}, surname: {}, fullName: {}, photo: {}}}}}},
        "read",
        actionUserCtx,
        languageCode
    );
    const populate = SchemaGuard.generatePopulate(sanitizedFields, Message.schema);
    const doc = await messageService.findByIdOrThrow(
        new ObjectId(messageId),
        {logger, languageCode},
        populate.populate,
        (populate.select || "") + " reactions._id"
    );

    const reactions = messageReactionsToDTO(doc.reactions);

    logger.finish(`Fetched ${reactions.length} reaction(s) for message ${messageId}`);
    return {reactions};
}

/**
 * PUT /api/user/chats/messages/reaction
 *
 * Adds an emoji reaction to a message. If the user already reacted, replaces it with the new emoji.
 * Emoji is encrypted before storage.
 *
 * @route PUT /api/user/chats/messages/reaction
 * @access Private
 * @requires Transaction
 * @body {AddMessageReactionFormType} - messageId, emoji
 * @returns {Promise<AddReactionFormResponseType>} reaction info (id, emoji, date, user)
 *
 * @throws {apiValidationException} If message not found/deleted or user not in channel
 *
 * @remarks
 * - Rate limited: 60 requests per minute
 * - Requires write access to Message.reactions via SchemaGuard
 * - Removes prior reaction by same user, then inserts new one (audited)
 * - Emits `MESSAGE_REACTION` WebSocket: `{ channelId, messageId }` (refetch `POST .../reaction/single`)
 */
router.put(
    "",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 60}),
    validateFormZod(addReactionFormSchema),
    transactionHandler(),
    asyncHandler(addMessageReaction)
);
/**
 * Adds an emoji reaction to a message, replacing existing reaction if present.
 * 
 * @param params - Transaction, form, and authenticated parameters
 * @returns Reaction information with ID, emoji, date, and user details
 */
async function addMessageReaction(params: TransactionRequired & AddReactionFormType & AuthenticatedMWType): Promise<AddReactionFormResponseType> {
    const { messageId, emoji, languageCode, logger, userInfo, company, session, actionUserCtx } = params;

    logger.start(`Adding reaction '${emoji}' to message ${messageId} by user ${userInfo._id.toString()}...`);
    SchemaGuard.sanitizeFields(Message, {reactions: {}}, "write", actionUserCtx, languageCode);

    // Find message and validate channel access
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
        },
        { session, logger, languageCode }
    )

    // Check if user already reacted with this emoji
    const existingReactions = (message.reactions || []);
    const existingReaction = existingReactions.find(
        (r) => {
            return r.user.toString() === userInfo._id.toString()
        }
    );

    if (existingReaction) {
        await messageService.updateById(
            message._id,
            {
                $pull: {
                    reactions: {
                        user: userInfo._id
                    }
                }
            },
            { session, logger, languageCode, auditUserId: actionUserCtx.userId }
        );
    }

    await messageService.updateById(
        message._id,
        {
            $push: {
                reactions: {
                    _id: existingReaction?._id || new ObjectId(),
                    emoji: EncryptString(emoji),
                    user: userInfo._id,
                    createdAt: new Date()
                }
            }
        },
        { session, logger, languageCode, auditUserId: actionUserCtx.userId }
    );

    let returnThis: AddReactionFormResponseType = null;

    try{
        let sanitizedFields = SchemaGuard.sanitizeFields(Message, {reactions: {keys: {emoji: {}, date: {}, user: {keys: {name: {}, surname: {}, fullName: {}, photo: {}}}}}}, "read", actionUserCtx, languageCode);
        let populate = SchemaGuard.generatePopulate(sanitizedFields, Message.schema);
        let modifiedMessage = await messageService.findOneOrThrow(
            {
                _id: message._id,
                status: { $ne: "deleted" },
                "reactions.user": userInfo._id,
            },
            { session, logger, languageCode },
            populate.populate,
            (populate.select || "" ) + " reactions._id"
        );
        const reaction = (modifiedMessage.reactions || []).find(
            (r) => r.user && typeof r.user === "object" && "_id" in r.user && r.user._id.equals(userInfo._id)
        );
        returnThis = reaction ? messageReactionToDTO(reaction) : null;
    }catch(e){}

    try {
        const userIds = (messageChannel.users).map((u) => u._id.toString()).filter((id) => id !== userInfo._id.toString());
        const websocketMessage: WebSocketMessage<{channelId: string; messageId: string}> = {
            code: WebSocketMessageCodes.MESSAGE_REACTION,
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

    logger.finish(`Successfully ${existingReaction ? 'removed' : 'added'} reaction '${emoji}' to message ${messageId}`);
    return returnThis;
}

/**
 * DELETE /api/user/chats/messages/reaction
 *
 * Removes the user's reaction from a message.
 *
 * @route DELETE /api/user/chats/messages/reaction
 * @access Private
 * @requires Transaction
 * @body {RemoveMessageReactionFormType} - messageId, emoji
 * @returns {Promise<RemoveReactionFormResponseType>} removed reaction id
 *
 * @throws {apiValidationException} If message not found/deleted, user not in channel, or no reaction exists
 *
 * @remarks
 * - Rate limited: 60 requests per minute
 * - Requires write access to Message.reactions via SchemaGuard
 * - Removes reaction for the current user (audited)
 * - Emits `MESSAGE_REACTION` WebSocket: `{ channelId, messageId }`
 */
router.delete(
    "",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 60}),
    validateFormZod(removeReactionFormSchema),
    transactionHandler(),
    asyncHandler(removeMessageReaction)
);
/**
 * Removes an emoji reaction from a message.
 * 
 * @param params - Transaction, form, and authenticated parameters
 * @returns Removed reaction ID
 */
async function removeMessageReaction(params: TransactionRequired & RemoveReactionFormType & AuthenticatedMWType): Promise<RemoveReactionFormResponseType> {
    const { messageId, emoji, languageCode, logger, userInfo, company, session, actionUserCtx } = params;

    logger.start(`Removing reaction '${emoji}' from message ${messageId} by user ${userInfo._id.toString()}...`);
    SchemaGuard.sanitizeFields(Message, {reactions: {}}, "write", actionUserCtx, languageCode);

    const message = await messageService.findOneOrThrow(
        {
            _id: new ObjectId(messageId),
            status: { $ne: "deleted" },
            reactions: {
                $elemMatch: {
                    user: userInfo._id
                }
            }
        },
        { session, logger, languageCode }
    );
    let reaction = (message.reactions || []).shift();

    const messageChannel = await channelService.findOneOrThrow(
        {
            _id: message.channel._id,
            company: company._id,
            deleted: false,
            users: userInfo._id,
        },
        { session, logger, languageCode }
    )

    await messageService.updateById(
        message._id,
        {
            $pull: {
                reactions: {
                    user: userInfo._id
                }
            }
        },
        { session, logger, languageCode, auditUserId: actionUserCtx.userId }
    );

    try {
        const userIds = (messageChannel.users).map((u) => u._id.toString()).filter((id) => id !== userInfo._id.toString());
        const websocketMessage: WebSocketMessage<{channelId: string; messageId: string}> = {
            code: WebSocketMessageCodes.MESSAGE_REACTION,
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

    logger.finish(`Successfully removed reaction '${emoji}' from message ${messageId}`);
    return {
        _id: reaction._id.toString(),
    };
}


export { router };