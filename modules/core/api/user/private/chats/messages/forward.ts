import {Router} from "express";
import {ObjectId} from "mongodb";
import {asyncHandler} from "@coreModule/utilities/middlewares/asyncHandler";
import {validateFormZod} from "@coreModule/utilities/middlewares/validateFormZod";
import {transactionHandler} from "@coreModule/utilities/middlewares/transactionHandler";
import {TransactionRequired} from "@coreModule/utilities/middlewares/transactionUtils";
import authMW, {AuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import {EncryptString} from "@coreModule/utilities/security/encryption";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {
    ForwardMessageFormResponseType,
    MessageTypeWithParticipants
} from "armonia/src/modules/core/api/user/private/chats/messages/messages.form.response.type";
import {
    ForwardMessageFormType
} from "armonia/src/modules/core/api/user/private/chats/messages/forwardMessage.form.type";
import {
    forwardMessageFormSchema
} from "armonia/src/modules/core/api/user/private/chats/messages/forwardMessage.form.validator";
import {channelService} from "@coreModule/database/schemas/channel/channel.service";
import {messageService} from "@coreModule/database/schemas/message/message.service";
import {messagesToDTO} from "@coreModule/utilities/mappers/message/messageMapper.dto";
import Message from "@coreModule/database/schemas/message/message";
import {IChannel} from "@coreModule/database/schemas/channel/channel";
import SchemaGuard from "@coreModule/database/security/schemaGuard";
import {rateLimiter} from "@coreModule/utilities/middlewares/rateLimiter";
import {WebSocketMessage, WebSocketMessageCodes} from "armonia/src/modules/core/websocket/types";
import {pushWebsocketMessage} from "@coreModule/domain/websocket/pushWebsocketMessage";
import {COLLECTED_DATA} from "@coreModule/database/collections";

const router = Router();

/**
 * PUT /api/user/chats/messages/forward
 *
 * Forwards a message to one or more channels. Creates a new message per target channel,
 * copying the original content (encrypted text/media) and optional new text.
 *
 * @route PUT /api/user/chats/messages/forward
 * @access Private
 * @requires Transaction
 * @body {ForwardMessageFormType} - messageId, channelIds, text?
 * @returns {Promise<ForwardMessageFormResponseType>} one message DTO per target channel (`channelId` set)
 *
 * @throws {apiValidationException} If original message not found/deleted or channel access denied
 *
 * @remarks
 * - Rate limited: 60 requests per minute
 * - Requires write access to Message.forwardedText via SchemaGuard
 * - Creates one message per target channel (audited)
 * - Emits `NEW_MESSAGE` WebSocket events per target channel
 */
router.put(
    "",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 60}),
    validateFormZod(forwardMessageFormSchema),
    transactionHandler(),
    asyncHandler(forwardMessage)
);
/**
 * Forwards a message to multiple channels.
 *
 * @param params - Transaction, form, and authenticated parameters
 * @returns {Promise<ForwardMessageFormResponseType>}
 */
async function forwardMessage(params: TransactionRequired & ForwardMessageFormType & AuthenticatedMWType): Promise<ForwardMessageFormResponseType> {
    const { messageId, channelIds, text, languageCode, logger, userInfo, company, session, actionUserCtx, actionUserInfo } = params;

    logger.start(`Forwarding message ${messageId} to ${channelIds.length} channel(s)...`);
    SchemaGuard.sanitizeFields(Message, {forwardedText: {}}, "write", actionUserCtx, languageCode);

    // Validate original message exists and user has access
    const originalMessage = await messageService.findOneOrThrow(
        {
            _id: new ObjectId(messageId),
            status: { $ne: "deleted" }
        },
        { session, logger, languageCode }
    );

    await channelService.findOneOrThrow(
        {
            _id: originalMessage.channel._id,
            company: company._id,
            users: userInfo._id,
            deleted: false
        },
        { session, logger, languageCode },
        [
            {
                path: "users",
                select: "_id username"
            }
        ]
    );

    const targetedChannels = await channelService.find(
        {
            _id: {
                $in: channelIds
            },
            company: company._id,
            users: userInfo._id,
            deleted: false
        },
        { session, logger, languageCode },
        [
            {
                path: "users",
                select: "_id username"
            }
        ]
    );

    if( targetedChannels.length !== channelIds.length ) {
        logger.debug(`Not all target channels found or user not a member`);
        throw apiValidationException("channel_not_yours", null, null, languageCode);
    }

    // Create forwarded messages in each target channel
    const forwardedMessages: MessageTypeWithParticipants[] = [];
    let messageIds: ObjectId[] = [];
    let notifyUsers: string[] = [];

    logger.debug(`Creating forwarded messages in ${targetedChannels.length} channel(s)...`);
    for (const targetChannel of targetedChannels) {
        notifyUsers = notifyUsers.concat(targetChannel.users.map(user => user._id.toString()));
        // Create forwarded message
        const forwardedMessage = await messageService.create(
            {
                sender: userInfo,
                channel: targetChannel,
                forwardedText: originalMessage.text,
                text: EncryptString(text ?? ""),
                mediaIds: originalMessage.mediaIds || [],
                type: "message",
                status: "active",
                company: company._id
            },
            { session, logger, languageCode, auditUserId: actionUserCtx.userId }
        );
        messageIds.push(forwardedMessage._id);
    }

    const populate = SchemaGuard.generatePopulate(COLLECTED_DATA["messages"].readFields, Message.schema);

    logger.debug(`Fetching messages...`);
    const messages = await messageService.find(
        {
            _id: {
                $in: messageIds
            }
        },
        {session, logger, languageCode},
        populate.populate,
        (populate.select || "") + " channel"
    )
    logger.debug(`Fetched ${messages.length} messages`);

    // Convert to DTOs
    logger.debug(`Converting messages to DTOs...`);
    const returnThis = await messagesToDTO(messages, userInfo._id.toString());

    // Map messages to include channelId for MessageTypeWithParticipants
    const messagesWithChannelId: MessageTypeWithParticipants[] = returnThis.map((msg, index) => {
        const message = messages[index];
        const channelId = message.channel instanceof ObjectId
            ? message.channel.toString()
            : (message.channel as unknown as IChannel)._id.toString();
        return {
            ...msg,
            channelId
        };
    });

    try {
        for (const targetChannel of targetedChannels) {
            const allUserIds = (targetChannel.users).map((user) => user._id.toString()).filter((userId) => userId !== actionUserInfo._id.toString());
            const messageWithChannelId = messagesWithChannelId.find(x => x.channelId === targetChannel._id.toString());

            logger.debug(`Sending WebSocket notification to ${allUserIds.length} user(s)`);

            const websocketMessage: WebSocketMessage<{channelId: string, messageId: string}> = {
                code: WebSocketMessageCodes.NEW_MESSAGE,
                payload: {
                    channelId: targetChannel._id.toString(),
                    messageId: messageWithChannelId._id.toString()
                },
                userIds: allUserIds
            }
            pushWebsocketMessage(websocketMessage);
        }
    } catch (e) {
        // WebSocket notification failure should not break the request
        logger.debug(`Failed to send WebSocket notification: ${e}`);
    }


    logger.finish(`Successfully forwarded message ${messageId} to ${messagesWithChannelId.length} channel(s)`);

    return {
        messages: messagesWithChannelId
    };
}


export { router };