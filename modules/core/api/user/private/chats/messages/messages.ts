import {Router} from "express";
import {ObjectId} from "mongodb";
import {asyncHandler} from "@coreModule/utilities/middlewares/asyncHandler";
import {validateFormZod} from "@coreModule/utilities/middlewares/validateFormZod";
import {transactionHandler} from "@coreModule/utilities/middlewares/transactionHandler";
import {TransactionRequiredParams} from "@coreModule/utilities/middlewares/transactionUtils";
import authMW, {AuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import {EncryptString} from "@coreModule/utilities/security/encryption";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {MessagesFormType} from "armonia/src/modules/core/api/user/private/chats/messages/messages.form.type";
import {
    MessagesFormResponseType,
    MessageTypeWithParticipants
} from "armonia/src/modules/core/api/user/private/chats/messages/messages.form.response.type";
import {NewMessageFormType} from "armonia/src/modules/core/api/user/private/chats/messages/newMessage.form.type";
import {messagesFormSchema} from "armonia/src/modules/core/api/user/private/chats/messages/messages.form.validator";
import {
    GetMessageSingleFormType
} from "armonia/src/modules/core/api/user/private/chats/messages/getMessageSingle.form.type";
import {
    GetMessageSingleFormResponseType
} from "armonia/src/modules/core/api/user/private/chats/messages/getMessageSingle.form.response.type";
import {
    getMessageSingleFormSchema
} from "armonia/src/modules/core/api/user/private/chats/messages/getMessageSingle.form.validator";
import {EditMessageFormType} from "armonia/src/modules/core/api/user/private/chats/messages/editMessage.form.type";
import {
    EditMessageFormResponseType
} from "armonia/src/modules/core/api/user/private/chats/messages/editMessage.form.response.type";
import {DeleteMessageFormType} from "armonia/src/modules/core/api/user/private/chats/messages/deleteMessage.form.type";
import {
    DeleteMessageFormResponseType
} from "armonia/src/modules/core/api/user/private/chats/messages/deleteMessage.form.response.type";
import {channelService} from "@coreModule/database/schemas/channel/channel.service";
import {
    lastChannelReadMessageService
} from "@coreModule/database/schemas/lastChannelReadMessage/lastChannelReadMessage.service";
import {messageService} from "@coreModule/database/schemas/message/message.service";
import {userService} from "@coreModule/database/schemas/user/user.service";
import {messagesToDTO, messageToDTO} from "@coreModule/utilities/mappers/message/messageMapper.dto";
import Message, {IMessage} from "@coreModule/database/schemas/message/message";
import {newMessageFormSchema} from "armonia/src/modules/core/api/user/private/chats/messages/newMessage.form.validator";
import {
    editMessageFormSchema
} from "armonia/src/modules/core/api/user/private/chats/messages/editMessage.form.validator";
import {
    deleteMessageFormSchema
} from "armonia/src/modules/core/api/user/private/chats/messages/deleteMessage.form.validator";
import {MediaUploaded, mediaUploadMW} from "@coreModule/utilities/middlewares/mediaUploadMW";
import {IUser} from "@coreModule/database/schemas/user/user";
import {IChannel} from "@coreModule/database/schemas/channel/channel";
import {ClientSession, UpdateQuery} from "mongoose";
import SchemaGuard from "@coreModule/database/security/schemaGuard";
import {rateLimiter} from "@coreModule/utilities/middlewares/rateLimiter";
import {schemaSanitizer, SchemaSanitizerMWType} from "@coreModule/utilities/middlewares/schemaSanitizerMW";
import {WebSocketMessage, WebSocketMessageCodes} from "armonia/src/modules/core/websocket/types";
import {pushWebsocketMessage} from "@coreModule/domain/websocket/pushWebsocketMessage";
import {emitNotificationEvent, NotificationEventCodes} from "@coreModule/domain/notifications/notificationEventBus";
import {dispatchAiChannelMessage} from "@coreModule/domain/ai/notifyAssistantOffline";

/**
 * Chat messages API – private endpoints for listing and managing messages.
 *
 * Mounted under the user private chat routes (e.g. `/user/chats/messages`). All handlers require
 * authentication. Read routes allow direct members or group channels where the user left but
 * `showChannel` is true; **creating messages (PUT)** requires the user to be in `channel.users`.
 * Field-level access enforced via SchemaGuard where middleware is attached.
 *
 * **Routes (registration order):**
 * - `POST ""` – Paginated list of messages.
 * - `POST "/single"` – One message by id (channel access + visibility rules).
 * - `PUT ""` – Create a new message (text/media/reply/mentions).
 * - `DELETE ""` – Delete or hide messages (soft delete + per-user hide).
 * - `PATCH ""` – Edit an own message.
 *
 * @module f_endpoints/core/user/private/chats/messages
 */

const router = Router();

/**
 * Parses `@` mentions from message text: `@` followed by a 24-character hex MongoDB ObjectId string.
 *
 * @param text - Message body
 * @returns Unique mentioned user id strings (hex), in arbitrary order
 */
function parseMentions(text: string): string[] {
    const mentionRegex: RegExp = /@([a-fA-F0-9]{24})(?![a-fA-F0-9])/g;
    const mentions: Set<string> = new Set();
    let match: RegExpExecArray | null;
    while ((match = mentionRegex.exec(text)) !== null) {
        mentions.add(match[1]);
    }
    return Array.from(mentions);
}

/**
 * Ensures a last-read row exists for the user/channel and updates its timestamp.
 * Returns the previous `time` when updating; when creating the row, returns epoch (caller uses this as `lastRead` in list responses).
 */
async function ensureLastReadMessageTimestamp(params: {
    user: IUser;
    channelId: ObjectId;
    time: Date;
    session?: ClientSession;
    logger: AuthenticatedMWType["logger"];
    languageCode: string;
    auditUserId: string;
}): Promise<Date> {
    const { user, channelId, time, session, logger, languageCode, auditUserId } = params;
    const userId = user._id;

    const existingLastRead = await lastChannelReadMessageService.findOne(
        {
            user: userId,
            channel: channelId
        },
        { session, logger, languageCode }
    );

    time.setMilliseconds(time.getMilliseconds() + 1);
    if (!existingLastRead) {
        await lastChannelReadMessageService.create(
            {
                user,
                //@ts-expect-error
                channel: channelId,
                time
            },
            { session, logger, languageCode, auditUserId }
        );
        return new Date(0);
    }

    await lastChannelReadMessageService.updateById(
        existingLastRead._id,
        {
            time
        },
        { session, logger, languageCode, auditUserId }
    );

    return existingLastRead.time;
}

/**
 * POST /api/user/chats/messages
 *
 * Paginated list of messages in a channel with optional date filters.
 * Excludes messages hidden for the current user and updates last-read timestamp.
 *
 * @route POST /api/user/chats/messages
 * @access Private
 * @body {MessagesFormType} - channel, limit, earliestMessage?, oldestMessage?
 * @returns {Promise<MessagesFormResponseType>} lastRead and messages (newest-first query, reversed to chronological for the client)
 *
 * @throws {apiValidationException} If channel not found or user not in channel
 *
 * @remarks
 * - Rate limited: 60 requests per minute
 * - Default `createdAt` window: after Unix epoch through `now + 30 days` (narrow with `earliestMessage` / `oldestMessage` for cursoring)
 * - `limit` validated 1–1000
 * - Respects left-channel time for group channels (caps upper bound for users who left)
 * - Updates or creates last read timestamp (audited)
 */
router.post(
    "",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 60}),
    validateFormZod(messagesFormSchema),
    schemaSanitizer({model: "messages", requiredModes: ["read"]}),
    asyncHandler(getMessages)
);
type GetMessagesType = AuthenticatedMWType & SchemaSanitizerMWType;
/**
 * Fetches paginated messages from a channel and updates last read timestamp.
 *
 * @param params - Form and authenticated parameters
 * @returns Paginated messages and last read timestamp
 */
async function getMessages(params: GetMessagesType & MessagesFormType): Promise<MessagesFormResponseType> {

    const { channel, earliestMessage, languageCode, logger, userInfo, company, oldestMessage, limit, actionUserCtx, sanitizedReadFields } = params;

    logger.debug(`Earliest message filter: ${earliestMessage || "none"}`);
    logger.debug(`Oldest message filter: ${oldestMessage || "none"}`);

    const populate = SchemaGuard.generatePopulate(sanitizedReadFields, Message.schema);

    logger.debug(`Validating channel access...`);
    const selectedChannel = await channelService.findOneOrThrow(
        {
            _id: new ObjectId(channel),
            company: company._id,
            deleted: false,
            $or: [
                {
                    users: userInfo._id,
                },
                {
                    isGroup: true,
                    leftUsers: {
                        $elemMatch: {
                            user: userInfo._id,
                            showChannel: true
                        }
                    }
                }
            ]
        },
        { logger, languageCode },
        [
            {
                path: "users",
                select: "_id name surname photo"
            },
            {
                path: "leftUsers",
                select: "user time",
                populate: {
                    path: "user",
                    select: "_id"
                }
            }
        ]
    );

    const createdAt: {
        $gt: Date;
        $lte: Date;
    } = {
        $gt: new Date(0),
        $lte: new Date( Date.now() + 1000 * 60 * 60 * 24 * 30 )
    };

    const filter: any = {
        channel: selectedChannel._id,
        // status: { $ne: "deleted" },
        createdAt,
        deletedFor: {
            $not: {
                $elemMatch: {
                    user: userInfo._id,
                    showMessage: false
                }
            }
        }
    };

    if (earliestMessage) {
        // if earliestMessage is set, then we must return all messages newer than it
        filter.createdAt.$gt = new Date(earliestMessage);
    }
    else{
        if( !!oldestMessage ){
            // if oldestMessage is set, then we must return all messages older than it
            filter.createdAt.$lt = new Date(oldestMessage);
        }
    }

    if (selectedChannel.leftUsers && Array.isArray(selectedChannel.leftUsers)) {
        const found = selectedChannel.leftUsers.find((leftUser) => leftUser.user._id.equals(userInfo._id));
        if (found) {
            logger.debug(`User left channel at ${found.time}, filtering messages before this time`);
            if( filter.createdAt.$lte > found.time ){
                filter.createdAt.$lte = found.time;
            }
        }
    }

    // Get paginated messages with optimized query
    logger.debug(`Fetching messages...`);
    const messages = await messageService.find(
        filter,
        {logger, languageCode},
        populate.populate,
        (populate.select || "") + " type status reactions._id deletedFor",
        {
            createdAt: -1
        },
        limit
    )
    logger.debug(`Fetched ${messages.length} messages`);

    // Convert to DTOs
    logger.debug(`Converting messages to DTOs...`);
    const returnThis = await messagesToDTO(messages, userInfo._id.toString());

    // Update or create the last read message timestamp
    logger.debug(`Updating last read message timestamp...`);
    const lastReadMessageDate = await ensureLastReadMessageTimestamp({
        user: userInfo,
        channelId: selectedChannel._id,
        time: new Date(),
        logger,
        languageCode,
        auditUserId: actionUserCtx.userId
    });

    logger.finish(`Successfully fetched ${returnThis.length} messages from channel ${channel}`);

    return {
        lastRead: lastReadMessageDate,
        messages: returnThis.reverse()
    };
}

/**
 * POST /api/user/chats/messages/single
 *
 * Returns one message by id if the user can access its channel and the message is not
 * hidden for them (same visibility rules as the paginated list, including left-channel cutoff).
 *
 * @route POST /api/user/chats/messages/single
 * @access Private
 * @body {GetMessageSingleFormType} - messageId (ObjectId string)
 * @returns {Promise<GetMessageSingleFormResponseType>} Message DTO (same shape as list items)
 *
 * @throws {apiValidationException} If message not found or not visible to the user
 *
 * @remarks
 * - Rate limited: 60 requests per minute
 * - Read projection from schemaSanitizer sanitizedReadFields
 */
router.post(
    "/single",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 60}),
    validateFormZod(getMessageSingleFormSchema),
    schemaSanitizer({model: "messages", requiredModes: ["read"]}),
    asyncHandler(getMessageSingle)
);
type GetMessageSingleType = AuthenticatedMWType & SchemaSanitizerMWType;
/**
 * Fetches a single message visible to the current user in the current company.
 *
 * @param params - Auth, sanitizedReadFields, form (messageId)
 * @returns Message DTO
 */
async function getMessageSingle(params: GetMessageSingleType & GetMessageSingleFormType): Promise<GetMessageSingleFormResponseType> {
    const { messageId, languageCode, logger, userInfo, company, sanitizedReadFields } = params;

    logger.start(`Fetching single message ${messageId} for user ${userInfo._id.toString()}...`);

    const messageProbe = await messageService.findOneOrThrow(
        {_id: new ObjectId(messageId)},
        {logger, languageCode}
    );

    const channelId = messageProbe.channel instanceof ObjectId
        ? messageProbe.channel
        : (messageProbe.channel as IChannel)._id;

    const selectedChannel = await channelService.findOneOrThrow(
        {
            _id: channelId,
            company: company._id,
            deleted: false,
            $or: [
                {users: userInfo._id},
                {
                    isGroup: true,
                    leftUsers: {
                        $elemMatch: {
                            user: userInfo._id,
                            showChannel: true
                        }
                    }
                }
            ]
        },
        {logger, languageCode},
        [
            {
                path: "users",
                select: "_id name surname photo"
            },
            {
                path: "leftUsers",
                select: "user time",
                populate: {
                    path: "user",
                    select: "_id"
                }
            }
        ]
    );

    if (messageProbe.deletedFor && Array.isArray(messageProbe.deletedFor)) {
        for (const df of messageProbe.deletedFor) {
            const uid = df.user instanceof ObjectId ? df.user.toString() : (df.user as IUser)._id.toString();
            if (uid === userInfo._id.toString() && df.showMessage === false) {
                throw apiValidationException("message_not_found_or_not_yours", null, null, languageCode);
            }
        }
    }

    if (selectedChannel.leftUsers && Array.isArray(selectedChannel.leftUsers)) {
        const found = selectedChannel.leftUsers.find((leftUser) => leftUser.user._id.equals(userInfo._id));
        if (found && messageProbe.createdAt > found.time) {
            throw apiValidationException("message_not_found_or_not_yours", null, null, languageCode);
        }
    }

    const populate = SchemaGuard.generatePopulate(sanitizedReadFields, Message.schema);
    const populatedMessage = await messageService.findByIdOrThrow(
        new ObjectId(messageId),
        {logger, languageCode},
        populate.populate,
        (populate.select || "") + " type status"
    );

    const dto = await messageToDTO(populatedMessage, userInfo._id.toString());
    if (!dto) {
        throw apiValidationException("message_not_found_or_not_yours", null, null, languageCode);
    }

    logger.finish(`Fetched message ${messageId}`);
    return dto;
}

/**
 * PUT /api/user/chats/messages
 *
 * Creates a new message in a channel. Supports text, media, mentions, and replies.
 * Message text is encrypted before storage; channel lastAction and last read are updated.
 *
 * @route PUT /api/user/chats/messages
 * @access Private
 * @requires Transaction
 * @requires MediaUpload (optional, max 500MB per file)
 * @body {NewMessageFormType} - channel, text?, replyTo?, fileIds?, mediaFiles? (require non-empty `text` or at least one attachment via `mediaFiles` / `fileIds`)
 * @returns {Promise<MessageTypeWithParticipants>} Created message + channel participants
 *
 * @throws {apiValidationException} If channel not found/not member or replyTo invalid
 *
 * @remarks
 * - Rate limited: 60 requests per minute
 * - Requires create permission on Message via SchemaGuard
 * - Updates channel lastAction and last read (audited)
 * - Emits `NEW_MESSAGE` WebSocket event to channel users
 */
router.put(
    "",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 60}),
    transactionHandler(),
    mediaUploadMW({maxFileSize: 1024 * 1024 * 500}),
    validateFormZod(newMessageFormSchema),
    schemaSanitizer({model: "messages", requiredModes: ["read"]}),
    asyncHandler(putMessage)
);
type PutMessageType = TransactionRequiredParams & NewMessageFormType & MediaUploaded & SchemaSanitizerMWType;
/**
 * Creates a new message in a channel with optional media, mentions, and replies.
 *
 * @param params - Transaction, media upload, and form parameters
 * @returns Created message with channel participants
 */
async function putMessage(params: PutMessageType): Promise<MessageTypeWithParticipants> {
    const { channel, mediaFiles, languageCode, logger, userInfo, company, session, actionUserCtx, replyTo, fileIds, sanitizedReadFields, actionUserInfo } = params;
    const text = params.text ?? "";

    logger.start(`Creating new message in channel ${channel} for user ${userInfo._id.toString()}...`);
    logger.debug(`Message length: ${text.length} characters, Media files: ${mediaFiles}`);
    SchemaGuard.checkModelPermission(Message, "create", actionUserCtx, languageCode);

    // Validate channel access atomically
    logger.debug(`Validating channel access for user ${userInfo._id.toString()}...`);

    const selectedChannel = await channelService.findOneOrThrow(
        {
            _id: new ObjectId(channel),
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

    let mentionedUsers: IUser[] = undefined;
    let mentionedUserIds = parseMentions(text).map((id) => new ObjectId(id));
    if (mentionedUserIds.length > 0) {
        let channelUsersIds = selectedChannel.users.map((u) => u._id.toString());
        mentionedUserIds = mentionedUserIds.filter((id) => channelUsersIds.includes(id.toString()));
        mentionedUsers = await userService.find({ _id: { $in: mentionedUserIds } }, { session, logger, languageCode });
        logger.debug(`Found ${mentionedUserIds.length} valid mentioned user(s) in channel`);
    }

    let replyToMessage: any;
    if( !!replyTo ){
        replyToMessage = await messageService.findOneOrThrow(
            {
                _id: new ObjectId(replyTo),
                channel: selectedChannel._id,
                status: { $ne: "deleted" }
            },
            { session, logger, languageCode }
        );
    }

    const mediaIds = (fileIds?.map((id) => new ObjectId(id)) ?? undefined) as unknown as IMessage["mediaIds"];
    const message = await messageService.create(
        {
            sender: userInfo,
            channel: selectedChannel,
            text: EncryptString(text),
            type: "message",
            status: "active",
            replyTo: replyToMessage,
            mentionedUsers: mentionedUsers,
            company: selectedChannel.company,
            mediaIds
        },
        { session, logger, languageCode, auditUserId: actionUserCtx.userId }
    );

    // Update channel lastAction timestamp
    logger.debug(`Updating channel lastAction timestamp...`);
    await channelService.updateById(
        new ObjectId(channel),
        { lastAction: new Date() },
        { session, logger, languageCode, auditUserId: actionUserCtx.userId }
    );

    // Update or create the last read message timestamp
    logger.debug(`Updating last read message timestamp...`);
    await ensureLastReadMessageTimestamp({
        user: userInfo,
        channelId: new ObjectId(channel),
        time: message.createdAt,
        session,
        logger,
        languageCode,
        auditUserId: actionUserCtx.userId
    });

    const populate = SchemaGuard.generatePopulate(sanitizedReadFields, Message.schema);

    logger.debug(`Fetching messages...`);
    const populatedMessage = await messageService.findByIdOrThrow(
        message._id,
        {session, logger, languageCode},
        populate.populate,
        (populate.select || "") + " type status",
    )

    // Send WebSocket notification to other channel members
    try {
        const allUserIds = (selectedChannel.users).map((user) => user._id.toString()).filter((userId) => userId !== actionUserInfo._id.toString());

        logger.debug(`Sending WebSocket notification to ${allUserIds.length} user(s)`);

        const websocketMessage: WebSocketMessage<{channelId: string, messageId: string}> = {
            code: WebSocketMessageCodes.NEW_MESSAGE,
            payload: {
                channelId: selectedChannel._id.toString(),
                messageId: populatedMessage._id.toString()
            },
            userIds: allUserIds
        };
        pushWebsocketMessage(websocketMessage);

        const mentionReceiverIds = mentionedUserIds
            .map((id) => id.toString())
            .filter((id) => id !== actionUserInfo._id.toString());
        if (mentionReceiverIds.length > 0) {
            emitNotificationEvent(
                NotificationEventCodes.MESSAGE_MENTIONED, 
                {
                    receiverIds: mentionReceiverIds,
                    payload: {
                        senderId: actionUserInfo._id.toString(),
                        companyId: company._id.toString(),
                        channelId: selectedChannel._id.toString(),
                        messageId: message._id.toString(),
                        senderUsername: actionUserInfo.username,
                        channelName: (selectedChannel as IChannel).name ?? "a channel",
                        languageCode
                    },
                    session
                }
            );
        }

    } catch (e) {
        // WebSocket notification failure should not break the request
        logger.debug(`Failed to send WebSocket notification: ${e}`);
    }

    // AI-assistant channel: hand off to the responder ("Layer 2"). Fire-and-forget —
    // the user's message is already saved/delivered. The responder runs in its own
    // process (assistantServer); if it is offline the dispatcher DISCARDS the
    // message (no queuing) and posts a "not available" notice instead of answering.
    // Never trigger on the bot's own messages, which would loop.
    if ((selectedChannel as IChannel).isAiAssistant && !userInfo.isBot) {
        void dispatchAiChannelMessage({
            companyId: company._id.toString(),
            channelId: selectedChannel._id.toString(),
            userId: userInfo._id.toString(),
            messageId: message._id.toString(),
            text,
            languageCode,
            logger
        });
    }

    logger.debug(`Converting messages to DTOs...`);
    const returnThis = await messageToDTO(populatedMessage, userInfo._id.toString());

    logger.finish(`Successfully created message ${message._id.toString()} in channel ${channel}`);

    return {
        channelId: channel,
        ...returnThis
    };
}

/**
 * DELETE /api/user/chats/messages
 *
 * Deletes one or more messages from a channel. Own messages are soft-deleted first;
 * subsequent delete hides them for the user. Other users' messages are hidden for the user.
 *
 * @route DELETE /api/user/chats/messages
 * @access Private
 * @requires Transaction
 * @body {DeleteMessageFormType} - messageIds[]
 * @returns {Promise<DeleteMessageFormResponseType>} Success message
 *
 * @throws {apiValidationException} If messages not found, multiple channels, or no access
 *
 * @remarks
 * - Not rate limited (unlike list/single/create)
 * - Requires delete permission on Message via SchemaGuard
 * - Uses bulk updates (audit coverage limited for updateMany)
 * - Emits `MESSAGE_DELETED` WebSocket when the user’s own messages are soft-deleted for the first time (not for hide-only updates on others’ messages)
 */
router.delete(
    "",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 60}),
    validateFormZod(deleteMessageFormSchema),
    transactionHandler(),
    asyncHandler(deleteMessage)
);
type DeleteMessageType = TransactionRequiredParams & DeleteMessageFormType;
/**
 * Deletes messages with per-user visibility control.
 *
 * @param params - Transaction and form parameters
 * @returns Success message
 */
async function deleteMessage(params: DeleteMessageType): Promise<DeleteMessageFormResponseType> {
    const { messageIds, languageCode, logger, userInfo, company, session, actionUserCtx, actionUserInfo} = params;

    logger.start(`Deleting ${messageIds.length} message(s) for user ${userInfo._id.toString()}...`);
    SchemaGuard.checkModelPermission(Message, "delete", actionUserCtx, languageCode);

    if (messageIds.length === 0) {
        logger.debug(`No messages provided for deletion`);
        return { message: "No messages selected" };
    }

    const messageObjectIds = messageIds.map((id: string) => new ObjectId(id));
    logger.debug(`Message IDs: ${messageIds.join(", ")}`);

    // Find all messages and verify they exist
    logger.debug(`Finding messages to delete...`);
    const messages = await messageService.find(
        {
            _id: {
                $in: messageObjectIds,
            }
        },
        { session, logger, languageCode }
    );

    if (!messages || messages.length === 0) {
        logger.debug(`No messages found with provided IDs`);
        throw apiValidationException("message_not_found_or_not_yours", null, null, languageCode);
    }
    if (messages.length !== messageIds.length) {
        logger.debug(`Expected ${messageIds.length} messages, found ${messages.length}`);
        throw apiValidationException("message_not_found_or_not_yours", null, null, languageCode);
    }
    logger.debug(`Found ${messages.length} message(s) to delete`);

    // Verify all messages are from the same channel
    logger.debug(`Verifying all messages are from the same channel...`);
    const allMessagesChannelIds: string[] = [];
    for (const message of messages) {
        const channelId = message.channel instanceof ObjectId
            ? message.channel.toString()
            : (message.channel as unknown as IChannel)._id.toString();
        if (!allMessagesChannelIds.includes(channelId)) {
            allMessagesChannelIds.push(channelId);
        }
    }
    if (allMessagesChannelIds.length !== 1) {
        logger.debug(`Messages span ${allMessagesChannelIds.length} channel(s), must be from same channel`);
        throw apiValidationException("all_messages_must_be_part_of_same_channel", null, null, languageCode);
    }
    logger.debug(`All messages are from channel ${allMessagesChannelIds[0]}`);

    // Verify user has access to the channel
    logger.debug(`Validating channel access...`);
    const messagesChannel = await channelService.findOne({
        _id: new ObjectId(allMessagesChannelIds[0]),
        company: company._id,
        users: userInfo._id,
        deleted: false
    }, { session, logger, languageCode });

    if (!messagesChannel) {
        logger.debug(`User ${userInfo._id.toString()} does not have access to channel ${allMessagesChannelIds[0]}`);
        throw apiValidationException("channel_not_yours", null, null, languageCode);
    }
    logger.debug(`Channel access validated`);

    // Handle user's own messages (first deletion - set deletedForAll = true)
    logger.debug(`Finding user's own messages for first deletion...`);
    const myMessages = await messageService.find(
        {
            _id: { $in: messageObjectIds },
            sender: userInfo._id,
            deletedAt: {$exists: false}
        },
        { session, logger, languageCode }
    );

    if (myMessages.length > 0) {
        logger.debug(`Deleting ${myMessages.length} user's own message(s) for the first time...`);
        await messageService.updateMany(
            {
                _id: { $in: myMessages.map(x => x._id) }
            },
            {
                status: "deleted",
                deletedAt: new Date(),
            } as UpdateQuery<IMessage>,
            { session, logger, languageCode, auditUserId: actionUserCtx.userId }
        );
        logger.debug(`Successfully deleted ${myMessages.length} message(s) for all users`);
    }

    // Handle user's own messages (second deletion - permanently hide)
    logger.debug(`Finding already deleted messages for permanent hiding...`);
    const alreadyDeletedMessages = await messageService.find(
        {
            _id: {
                $in: messageObjectIds,
                $nin: myMessages.map(x => x._id)
            },
            sender: userInfo._id,
            deletedAt: {$exists: true}
        },
        { session, logger, languageCode }
    );

    if (alreadyDeletedMessages.length > 0) {
        logger.debug(`Permanently hiding ${alreadyDeletedMessages.length} already deleted message(s)...`);
        await messageService.updateMany(
            {
                _id: { $in: alreadyDeletedMessages.map(x => x._id) },
                "deletedFor.user": {$ne: userInfo._id}
            },
            {
                status: "deleted",
                $push: {
                    deletedFor: {
                        user: userInfo._id,
                        time: new Date(Date.now()),
                        showMessage: false
                    }
                }
            } as UpdateQuery<IMessage>,
            { session, logger, languageCode, auditUserId: actionUserCtx.userId }
        );
        logger.debug(`Successfully permanently hidden ${alreadyDeletedMessages.length} message(s)`);
    }

    // Handle other users' messages (add to deletedFor array)
    logger.debug(`Finding other users' messages to hide for current user...`);
    const othersMessages = await messageService.find(
        {
            _id: { $in: messageObjectIds },
            sender: { $nin: [userInfo._id] },
            deletedFor: { $not: { $elemMatch: { user: userInfo._id } } }
        },
        { session, logger, languageCode }
    );

    if (othersMessages.length > 0) {
        logger.debug(`Hiding ${othersMessages.length} other user's message(s) for current user...`);
        await messageService.updateMany(
            {
                _id: { $in: othersMessages.map(x => x._id) }
            },
            {
                $push: {
                    deletedFor: {
                        user: userInfo._id,
                        time: new Date(Date.now()),
                        showMessage: false
                    }
                }
            } as UpdateQuery<IMessage>,
            { session, logger, languageCode, auditUserId: actionUserCtx.userId }
        );
        logger.debug(`Successfully hidden ${othersMessages.length} message(s) for current user`);
    }

    try {
        if( !!myMessages && myMessages.length > 0 ){
            const websocketMessage: WebSocketMessage<{channelId: string, messageIds: string[]}> = {
                code: WebSocketMessageCodes.MESSAGE_DELETED,
                payload: {
                    channelId: messagesChannel._id.toString(),
                    messageIds: myMessages.map(x => x._id.toString())
                },
                userIds: (messagesChannel.users).map((user) => user._id.toString()).filter((userId) => userId !== actionUserInfo._id.toString())
            }
            pushWebsocketMessage(websocketMessage);
        }
    }
    catch (e) {
        logger.debug(`Failed to send WebSocket notification: ${e}`);
    }

    const totalDeleted = myMessages.length + alreadyDeletedMessages.length + othersMessages.length;
    logger.finish(`Successfully deleted ${totalDeleted} message(s) (own: ${myMessages.length + alreadyDeletedMessages.length}, others: ${othersMessages.length})`);

    return {
        message: "Messages successfully deleted"
    };
}

/**
 * PATCH /api/user/chats/messages
 *
 * Edits a message owned by the current user. Updates text and mentions, marks as edited.
 *
 * @route PATCH /api/user/chats/messages
 * @access Private
 * @requires Transaction
 * @body {EditMessageFormType} - messageId, text
 * @returns {Promise<EditMessageFormResponseType>} updated message text
 *
 * @throws {apiValidationException} If message not found, deleted, or not owned by user
 * @throws {apiValidationException} If atomic update fails (message deleted/ownership changed)
 *
 * @remarks
 * - Not rate limited (unlike list/single/create)
 * - Requires read permission for Message.text via SchemaGuard (`sanitizeFields`)
 * - Re-parses @mentions (24-char hex ObjectId strings) scoped to channel members; encrypts text; sets status to `edited`
 * - Emits `MESSAGE_EDITED` WebSocket event to other channel members
 */
router.patch(
    "",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 60}),
    validateFormZod(editMessageFormSchema),
    transactionHandler(),
    asyncHandler(editMessage)
);
/**
 * Edits a message owned by the user.
 * 
 * @param params - Transaction, form, and authenticated parameters
 * @returns Updated message text
 */
async function editMessage(params: TransactionRequiredParams & EditMessageFormType & AuthenticatedMWType): Promise<EditMessageFormResponseType> {
    const { messageId, text, languageCode, logger, userInfo, company, session, actionUserCtx, actionUserInfo } = params;

    logger.start(`Editing message ${messageId} for user ${userInfo._id.toString()}...`);
    logger.debug(`New text length: ${text.length} characters`);
    SchemaGuard.sanitizeFields(Message, {text: {}}, "read", actionUserCtx, languageCode);

    logger.debug(`Finding message and verifying ownership...`);
    const message = await messageService.findOneOrThrow(
        {
            _id: new ObjectId(messageId),
            sender: userInfo._id,
            status: { $ne: "deleted" }
        },
        { session, logger, languageCode }
    );

    const messageChannel = await channelService.findOneOrThrow(
        {
            _id: message.channel._id,
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

    let mentionedUsers: IUser[] = undefined;
    let mentionedUserIds = parseMentions(text).map((id) => new ObjectId(id));
    if (mentionedUserIds.length > 0) {
        let channelUsersIds = messageChannel.users.map((u) => u._id.toString());
        mentionedUserIds = mentionedUserIds.filter((id) => channelUsersIds.includes(id.toString()));

        mentionedUsers = await userService.find(
            {
                _id: {
                    $in: mentionedUserIds
                }
            },
            { session, logger, languageCode }
        );
        logger.debug(`Found ${mentionedUserIds.length} valid mentioned user(s) in channel`);
    }


    logger.debug(`Updating message text atomically...`);
    const updateResult = await messageService.updateOne(
        {
            _id: new ObjectId(messageId),
            channel: messageChannel._id,
            sender: userInfo._id,
            status: { $ne: "deleted" }
        },
        {
            text: EncryptString(text),
            status: "edited",
            mentionedUsers
        },
        { session, logger, languageCode, auditUserId: actionUserCtx.userId }
    );


    if (updateResult.matchedCount === 0) {
        logger.debug(`Atomic update failed - message may have been deleted or ownership changed`);
        throw apiValidationException("message_update_failed", null, null, languageCode);
    }
    logger.debug(`Message updated successfully (matched: ${updateResult.matchedCount}, modified: ${updateResult.modifiedCount})`);

    try {
        const websocketMessage: WebSocketMessage<{channelId: string, messageId: string}> = {
            code: WebSocketMessageCodes.MESSAGE_EDITED,
            payload: {
                channelId: messageChannel._id.toString(),
                messageId: message._id.toString()
            },
            userIds: (messageChannel.users).map((user) => user._id.toString()).filter((userId) => userId !== actionUserInfo._id.toString())
        }
        pushWebsocketMessage(websocketMessage);
    }
    catch (e) {
        logger.debug(`Failed to send WebSocket notification: ${e}`);
    }

    logger.debug(`Message populated successfully`);
    logger.finish(`Successfully edited message ${messageId}`);

    return {
        message: text
    };
}

export const basePath = '/api/user/chats/messages';
export { router };