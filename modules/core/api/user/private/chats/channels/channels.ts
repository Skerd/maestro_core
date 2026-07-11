import {Router} from "express";
import {ObjectId} from "mongodb";
import {asyncHandler} from "@coreModule/utilities/middlewares/asyncHandler";
import authMW, {AuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import {transactionHandler} from "@coreModule/utilities/middlewares/transactionHandler";
import {TransactionRequiredParams} from "@coreModule/utilities/middlewares/transactionUtils";
import {CreateChannelFormType} from "armonia/src/modules/core/api/user/private/chats/channels/createChannel.form.type";
import {
    CreateChannelFormResponseType
} from "armonia/src/modules/core/api/user/private/chats/channels/createChannel.form.response.type";
import {DeleteChannelFormType} from "armonia/src/modules/core/api/user/private/chats/channels/deleteChannel.form.type";
import {
    DeleteChannelFormResponseType
} from "armonia/src/modules/core/api/user/private/chats/channels/deleteChannel.form.response.type";
import {channelsToDTO, channelToDTO} from "@coreModule/utilities/mappers/channel/channelMapper.dto";
import {channelService} from "@coreModule/database/schemas/channel/channel.service";
import {ensureAiChannel} from "@coreModule/database/schemas/channel/aiChannel.helper";
import {messageService} from "@coreModule/database/schemas/message/message.service";
import {userService} from "@coreModule/database/schemas/user/user.service";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {
    deleteChannelFormSchema
} from "armonia/src/modules/core/api/user/private/chats/channels/deleteChannel.form.validator";
import {
    createChannelFormSchema
} from "armonia/src/modules/core/api/user/private/chats/channels/createChannel.form.validator";
import {IUser} from "@coreModule/database/schemas/user/user";
import Channel, {IChannel} from "@coreModule/database/schemas/channel/channel";
import {IMessage} from "@coreModule/database/schemas/message/message";
import {EncryptString} from "@coreModule/utilities/security/encryption";
import {AllChannelsFormType} from "armonia/src/modules/core/api/user/private/chats/channels/allChannels.form.type";
import {UpdateQuery} from "mongoose";
import {
    UpdateChannelDescriptionFormType
} from "armonia/src/modules/core/api/user/private/chats/channels/updateChannelDescription.form.type";
import {
    updateChannelDescriptionFormSchema
} from "armonia/src/modules/core/api/user/private/chats/channels/updateChannelDescription.form.validator";
import SchemaGuard from "@coreModule/database/security/schemaGuard";
import {rateLimiter} from "@coreModule/utilities/middlewares/rateLimiter";
import {
    AllChannelsFormResponseType
} from "armonia/src/modules/core/api/user/private/chats/channels/allChannels.form.response.type";
import {validateFormZod} from "@coreModule/utilities/middlewares/validateFormZod";
import {
    allChannelsFormSchema
} from "armonia/src/modules/core/api/user/private/chats/channels/allChannels.form.validator";
import {
    GetChannelSingleFormType
} from "armonia/src/modules/core/api/user/private/chats/channels/getChannelSingle.form.type";
import {
    getChannelSingleFormSchema
} from "armonia/src/modules/core/api/user/private/chats/channels/getChannelSingle.form.validator";
import {
    GetChannelSingleFormResponseType
} from "armonia/src/modules/core/api/user/private/chats/channels/getChannelSingle.form.response.type";
import {schemaSanitizer, SchemaSanitizerMWType} from "@coreModule/utilities/middlewares/schemaSanitizerMW";
import {WebSocketMessage, WebSocketMessageCodes} from "armonia/src/modules/core/websocket/types";
import {pushWebsocketMessage} from "@coreModule/domain/websocket/pushWebsocketMessage";
import {
    UpdateChannelDescriptionFormResponseType
} from "armonia/src/modules/core/api/user/private/chats/channels/updateChannelDescription.form.response.type";

const router = Router();

/**
 * POST /api/user/chats/channels
 *
 * Fetches paginated list of channels for the authenticated user in the current company.
 * Includes both active channels and channels the user has left but still wants to see.
 *
 * @route POST /api/user/chats/channels
 * @access Private
 * @body {AllChannelsFormType} - Optional name filter, pagination (offset, limit)
 * @returns {Promise<AllChannelsFormResponseType>} Paginated list of channels with metadata
 *
 * @remarks
 * - Read-only operation - no database writes occur
 * - Returns channels where user is active member or has left but showChannel=true
 * - Supports optional name filtering (case-insensitive regex)
 * - Pagination: max 200 items per page (see validator)
 * - Fields are filtered based on user's read permissions via schemaSanitizer
 * - Sorted by lastAction descending (most recent first)
 * - No audit logging needed as no changes are made
 */
router.post(
    "",
    authMW("private"),
    rateLimiter({
        windowMs: 60000,
        max: 600
    }),
    validateFormZod(allChannelsFormSchema),
    schemaSanitizer({model: "channels", requiredModes: ["read"]}),
    asyncHandler(userChannels)
);
type UserChannelsType = AuthenticatedMWType & SchemaSanitizerMWType;
/**
 * Fetches paginated list of user's channels with optional filtering.
 *
 * @param params - Form, auth, sanitizedReadFields
 * @returns Paginated list of channels
 */
async function userChannels(params: UserChannelsType & AllChannelsFormType): Promise<AllChannelsFormResponseType> {
    const { logger, userInfo, company, name, languageCode, offset, limit, actionUserCtx, sanitizedReadFields } = params;

    logger.start(`Fetching channels for user ${userInfo._id.toString()} in company ${company._id.toString()} (offset ${offset}, limit ${limit})...`);
    logger.debug(`Filter name: ${name || 'none'}`);

    const populate = SchemaGuard.generatePopulate(sanitizedReadFields, Channel.schema);

    // Build base match query - optimized to use indexes
    const baseMatch: any = {
        company: company._id,
        deleted: false,
        $or: [
            {
                users: userInfo._id
            },
            {
                leftUsers: {
                    $elemMatch: {
                        user: userInfo._id,
                        showChannel: true
                    }
                }
            }
        ]
    };

    // Apply name filter early if provided (before expensive lookups)
    if (name && name.trim()) {
        const nameRegex = new RegExp(name.trim(), "i");
        // For group channels, filter by name directly
        // For non-group, we'll filter after user lookup
        baseMatch.$or = [
            { ...baseMatch.$or[0], isGroup: true, name: nameRegex },
            { ...baseMatch.$or[0], isGroup: false, "users.fullName": nameRegex },
            { ...baseMatch.$or[1], isGroup: true, name: nameRegex },
            { ...baseMatch.$or[1], isGroup: false, "users.fullName": nameRegex}
        ];
    }

    logger.debug(`Building optimized aggregation pipeline...`);

    const [channels, totalCount] = await Promise.all([
        channelService.find(
            baseMatch,
            {logger, languageCode},
            populate.populate,
            (populate.select || "") + " isGroup",
            {
                lastAction: -1
            },
            limit,
            offset
        ),
        channelService.count(baseMatch, {logger, languageCode})
    ]);
    logger.debug(`Total channels matching criteria: ${totalCount}`);

    logger.debug(`Found ${channels.length} channel(s) in this chunk`);
    logger.debug(`Converting channels to DTO format...`);
    const channelDTOs = await channelsToDTO(channels, userInfo._id.toString(), actionUserCtx);

    logger.finish(`Successfully fetched and converted ${channelDTOs.length} channel(s)! (offset ${offset})`);

    return {
        data: channelDTOs,
        total: totalCount
    };
}

/**
 * POST /api/user/chats/channels/single
 *
 * Returns one channel by id for the authenticated user in the current company.
 * User must be an active member or a former member with showChannel=true on the left entry.
 *
 * @route POST /api/user/chats/channels/single
 * @access Private
 * @body {GetChannelSingleFormType} - id (ObjectId string)
 * @returns {Promise<GetChannelSingleFormResponseType>} Channel DTO (same shape as list items)
 *
 * @throws {apiValidationException} If channel not found or not visible to the user
 *
 * @remarks
 * - Read-only; projection from schemaSanitizer sanitizedReadFields
 * - Uses channelToDTO for parity with POST list
 */
router.post(
    "/single",
    authMW("private"),
    rateLimiter({
        windowMs: 60000,
        max: 60
    }),
    validateFormZod(getChannelSingleFormSchema),
    schemaSanitizer({model: "channels", requiredModes: ["read"]}),
    asyncHandler(getChannelSingle)
);
type GetChannelSingleType = AuthenticatedMWType & SchemaSanitizerMWType;
/**
 * Fetches a single channel visible to the current user.
 *
 * @param params - Auth, sanitizedReadFields, form (id)
 * @returns Channel DTO
 */
async function getChannelSingle(params: GetChannelSingleType & GetChannelSingleFormType): Promise<GetChannelSingleFormResponseType> {
    const { logger, userInfo, company, id, languageCode, actionUserCtx, sanitizedReadFields } = params;

    logger.start(`Fetching single channel ${id} for user ${userInfo._id.toString()}...`);

    const populate = SchemaGuard.generatePopulate(sanitizedReadFields, Channel.schema);

    const channel = await channelService.findOne(
        {
            _id: new ObjectId(id),
            company: company._id,
            deleted: false,
            $or: [
                { users: userInfo._id },
                {
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
        populate.populate,
        (populate.select || "") + " isGroup"
    );

    if (!channel) {
        logger.debug(`Channel ${id} not found or not accessible`);
        throw apiValidationException("channel_not_found", null, null, languageCode);
    }

    const channelDTO = await channelToDTO(channel, userInfo._id.toString(), actionUserCtx);
    if (!channelDTO) {
        throw apiValidationException("channel_not_found", null, null, languageCode);
    }

    logger.finish(`Fetched channel ${id}`);
    return channelDTO;
}

/**
 * POST /api/user/chats/channels/ai
 *
 * Returns the authenticated user's single AI-assistant channel with the company
 * bot, creating it on demand if it does not exist yet (lazy safety net that
 * complements eager creation on role grant). Idempotent - never creates a second
 * channel thanks to the get-or-create helper + partial unique index.
 *
 * @route POST /api/user/chats/channels/ai
 * @access Private
 * @returns {Promise<GetChannelSingleFormResponseType>} The AI-assistant channel DTO
 *
 * @throws {apiValidationException} If the company has no bot user (ai_channel_unavailable)
 *
 * @remarks
 * - No transaction: keeps the unique-index race-recovery path reachable
 * - Same DTO shape as GET single / list items
 */
router.post(
    "/ai",
    authMW("private"),
    rateLimiter({
        windowMs: 60000,
        max: 60
    }),
    schemaSanitizer({model: "channels", requiredModes: ["read"]}),
    asyncHandler(getOrCreateAiChannel)
);
type GetOrCreateAiChannelType = AuthenticatedMWType & SchemaSanitizerMWType;
/**
 * Gets or creates the current user's AI-assistant channel and returns its DTO.
 *
 * @param params - Auth, sanitizedReadFields
 * @returns AI-assistant channel DTO
 */
async function getOrCreateAiChannel(params: GetOrCreateAiChannelType): Promise<GetChannelSingleFormResponseType> {
    const { logger, userInfo, company, languageCode, actionUserCtx, sanitizedReadFields } = params;

    logger.start(`Get-or-create AI channel for user ${userInfo._id.toString()} in company ${company._id.toString()}...`);

    const aiChannel = await ensureAiChannel({
        userId: userInfo._id,
        companyId: company._id,
        logger,
        languageCode,
        auditUserId: actionUserCtx.userId
    });

    if (!aiChannel) {
        logger.debug(`AI channel unavailable (no company bot?)`);
        throw apiValidationException("ai_channel_unavailable", null, null, languageCode);
    }

    const populate = SchemaGuard.generatePopulate(sanitizedReadFields, Channel.schema);
    const channel = await channelService.findOne(
        { _id: aiChannel._id, company: company._id },
        { logger, languageCode },
        populate.populate,
        (populate.select || "") + " isGroup"
    );

    if (!channel) {
        throw apiValidationException("channel_not_found", null, null, languageCode);
    }

    const channelDTO = await channelToDTO(channel, userInfo._id.toString(), actionUserCtx);
    if (!channelDTO) {
        throw apiValidationException("channel_not_found", null, null, languageCode);
    }

    logger.finish(`AI channel ready: ${aiChannel._id.toString()}`);
    return channelDTO;
}

/**
 * PUT /api/user/chat/channels
 * 
 * Creates a new chat channel (direct message or group). For direct messages, checks if
 * a channel already exists between the users. Validates all users exist and belong to company.
 *
 * @route PUT /api/user/chats/channels
 * @access Private
 * @requires Transaction
 * @body {CreateChannelFormType} - User IDs to include, optional channel name
 * @returns {Promise<CreateChannelFormResponseType>} Created channel info or existing channel if found
 * 
 * @throws {apiValidationException} If no other users provided
 * @throws {apiValidationException} If current user included in userIds
 * @throws {apiValidationException} If one or more users not found
 * @throws {apiValidationException} If group channel requires name but none provided
 * 
 * @remarks
 * - Creates direct message channel (1 other user) or group channel (2+ other users)
 * - Direct messages: name is ignored, channel name auto-generated from participants
 * - Group channels: name is required
 * - Creator becomes owner and admin
 * - For direct messages, returns existing channel if one already exists
 * - SchemaGuard verifies create permission for Channel model
 * - Changes are audited with actionUserCtx.userId as the actor
 */
router.put(
    "",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 60}),
    validateFormZod(createChannelFormSchema),
    schemaSanitizer({model: "channels", requiredModes: ["read", "write"]}),
    transactionHandler(),
    asyncHandler(createUserChannel)
);
type CreateUserChannelType = TransactionRequiredParams & AuthenticatedMWType & SchemaSanitizerMWType;
/**
 * Creates a new chat channel (direct message or group).
 *
 * @param params - Transaction, form, auth, sanitized read/write fields
 * @returns Created or existing channel information
 */
async function createUserChannel(params: CreateUserChannelType & CreateChannelFormType): Promise<CreateChannelFormResponseType> {
    const { logger, userInfo, company, userIds, name, session, languageCode, actionUserCtx, sanitizedReadFields } = params;

    logger.start(`Creating channel with ${userIds.length} user(s)...`);
    SchemaGuard.checkModelPermission(Channel, "create", actionUserCtx, languageCode);

    logger.debug(`User IDs: ${userIds.join(', ')}, Channel name: ${name || 'none'}`);

    // Validate user IDs
    const usersObjectIds = userIds.map(id => new ObjectId(id));
    const filteredUserIds = userIds.filter(id => id !== userInfo._id.toString());

    if (filteredUserIds.length === 0) {
        logger.debug(`Validation failed: no other users provided`);
        throw apiValidationException("channel_must_have_at_least_one_member_that_is_not_you", null, null, languageCode);
    }

    if (userIds.some((id) => id === userInfo._id.toString())) {
        logger.debug(`Validation failed: current user included in userIds`);
        throw apiValidationException("user_cannot_be_part_of_channel_members_on_channel_create", null, null, languageCode);
    }

    // OPTIMIZED: Validate users exist and belong to company with active roles
    // Uses indexes on User._id and UserProfile.companies for fast lookups
    logger.debug(`Validating that all ${userIds.length} user(s) exist and belong to company...`);

    const foundUsers = await userService.find({
        _id: {
            $in: usersObjectIds
        },
        companies: company._id,
        "roles.company": company._id,
        "roles.active": "active",
    }, {session, logger, languageCode});

    if (foundUsers.length !== userIds.length) {
        logger.debug(`Validation failed: found ${foundUsers.length} users, expected ${userIds.length}`);
        throw apiValidationException("one_of_the_users_not_found", null, null, languageCode);
    }
    logger.debug(`All ${foundUsers.length} user(s) validated successfully`);

    // Determine channel type and validate name
    const isGroup = userIds.length > 1;
    let channelName = name;

    logger.debug(`Channel type: ${isGroup ? 'group' : 'direct message'}`);

    if (isGroup && !channelName) {
        logger.debug(`Validation failed: group channel requires a name`);
        throw apiValidationException("channel_name_is_required_when_creating_group_channel", null, null, languageCode);
    }
    else if (!isGroup && channelName) {
        logger.debug(`Direct message channel - clearing provided name`);
        channelName = "";
    }

    const populate = SchemaGuard.generatePopulate(sanitizedReadFields, Channel.schema);

    // The AI bot must never be a normal DM/group member - that would spawn a
    // second chat alongside the dedicated AI-assistant channel. Intercept here.
    const botTarget = foundUsers.find((u: IUser) => u.isBot);
    if (botTarget) {
        if (isGroup) {
            logger.debug(`Validation failed: cannot add AI bot to a group channel`);
            throw apiValidationException("cannot_add_ai_bot_to_channel", null, null, languageCode);
        }

        logger.debug(`Direct message targets the AI bot - routing to the dedicated AI-assistant channel`);
        const aiChannel = await ensureAiChannel({
            userId: userInfo._id,
            companyId: company._id,
            session,
            logger,
            languageCode,
            auditUserId: actionUserCtx.userId
        });

        if (!aiChannel) {
            throw apiValidationException("ai_channel_unavailable", null, null, languageCode);
        }

        const populatedAiChannel = await channelService.findOne(
            { company: company._id, _id: aiChannel._id },
            { session, logger, languageCode },
            populate.populate,
            (populate.select || "") + " isGroup"
        );

        logger.finish(`Returning AI-assistant channel ${aiChannel._id.toString()}`);
        return {
            message: "Channel already exists",
            alreadyExist: true,
            channelInfo: await channelToDTO(populatedAiChannel ?? aiChannel, userInfo._id.toString(), actionUserCtx)
        };
    }

    // For direct messages, check if channel already exists
    if (!isGroup) {
        logger.debug(`Checking for existing direct message channel...`);
        const checkUserIds = [...usersObjectIds, userInfo._id];

        const foundSameChannel = await channelService.findOne(
            {
                company: company._id,
                isGroup: false,
                users: {
                    $all: checkUserIds,
                    $size: checkUserIds.length
                },
                deleted: false
            },
            { session, logger, languageCode },
            populate.populate,
            (populate.select || "") + " isGroup"
        );

        if (foundSameChannel) {
            logger.debug(`Existing direct message channel found: ${foundSameChannel._id.toString()}`);
            logger.finish(`Channel already exists!`);
            return {
                message: "Channel already exists",
                alreadyExist: true,
                channelInfo: await channelToDTO(foundSameChannel, userInfo._id.toString(), actionUserCtx)
            };
        }
        logger.debug(`No existing direct message channel found - proceeding with creation`);
    }

    // Create new channel
    logger.debug(`Creating new ${isGroup ? 'group' : 'direct message'} channel...`);
    const newChannel = await channelService.create(
        {
            users: [...usersObjectIds, userInfo._id],
            owner: userInfo._id,
            company: company._id,
            name: channelName,
            isGroup,
            adminUsers: [userInfo._id]
        } as unknown as Partial<IChannel>,
        { session, logger, languageCode, auditUserId: actionUserCtx.userId }
    );
    logger.debug(`Channel created with ID: ${newChannel._id.toString()}`);

    // Fetch created channel with populated data
    logger.debug(`Fetching created channel with populated user and company data...`);

    const foundSameChannel = await channelService.findOne(
        {
            company: company._id,
            _id: newChannel._id
        },
        { session, logger, languageCode },
        populate.populate,
        (populate.select || "") + " isGroup"
    );

    if (!foundSameChannel) {
        throw apiValidationException("channel_creation_failed", null, null, languageCode);
    }

    logger.finish(`Successfully created channel ${foundSameChannel._id.toString()}!`);

    const channelDTO = await channelToDTO(foundSameChannel, userInfo._id.toString(), actionUserCtx);

    // Send WebSocket notification to all channel members about new channel
    try {
        const allUserIds = foundSameChannel.users.map((user: IUser) => user._id.toString());
        const websocketMessage: WebSocketMessage<{channelId: string}> = {
            code: WebSocketMessageCodes.CHANNEL_CREATED,
            payload: {
                channelId: foundSameChannel._id.toString()
            },
            userIds: allUserIds
        }
        pushWebsocketMessage(websocketMessage);

        logger.debug(`CHANNEL_CREATED notification sent successfully`);
    }
    catch (e) {
        logger.debug(`Failed to send CHANNEL_CREATED notification: ${e}`);
    }

    return {
        message: "Channel created",
        alreadyExist: false,
        channelInfo: channelDTO
    };
}

/**
 * PATCH /api/user/chats/channels/description
 *
 * Updates the description of a channel. Only channel owners and admins can update the description.
 * User must be an active member of the channel.
 *
 * @route PATCH /api/user/chats/channels/description
 * @access Private
 * @requires Transaction
 * @body {UpdateChannelDescriptionFormType} - Channel ID and new description
 * @returns {Promise<UpdateChannelDescriptionFormResponseType>} Updated channel information
 *
 * @throws {apiValidationException} If channel not found
 * @throws {apiValidationException} If user is not a channel member
 * @throws {apiValidationException} If user is not owner or admin
 *
 * @remarks
 * - Partial update; field-level write allowlist via schemaSanitizer on `channels`
 * - Updates lastAction timestamp
 * - Changes are audited with actionUserCtx.userId as the actor
 */
router.patch(
    "/description",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 60}),
    validateFormZod(updateChannelDescriptionFormSchema),
    transactionHandler(),
    asyncHandler(updateChannelDescription)
);
type UpdateChannelDescriptionType = TransactionRequiredParams & AuthenticatedMWType & SchemaSanitizerMWType;
/**
 * Updates channel description.
 *
 * @param params - Transaction, form, auth, sanitizedWriteFields
 * @returns Updated channel information
 */
async function updateChannelDescription(params: UpdateChannelDescriptionType & UpdateChannelDescriptionFormType): Promise<UpdateChannelDescriptionFormResponseType> {
    const { channelId, description, languageCode, logger, userInfo, company, session, actionUserCtx } = params;

    SchemaGuard.sanitizeFields(Channel, {description: {}}, "write", actionUserCtx, languageCode);

    logger.start(`Updating description for channel ${channelId} by user ${userInfo._id.toString()}...`);
    logger.debug(`New description: "${description}"`);

    const channel = await channelService.findOne(
        {
            _id: new ObjectId(channelId),
            company: company._id,
            deleted: false
        },
        { session, logger, languageCode },
        [
            { path: "users", select: "_id username" },
            { path: "owner", select: "_id username" },
            { path: "adminUsers", select: "_id username" }
        ]
    );

    if (!channel) {
        logger.debug(`Channel ${channelId} not found`);
        throw apiValidationException("channel_not_found", null, null, languageCode);
    }

    const isMember = (channel.users as unknown as IUser[]).some(
        (u: IUser) => u._id.toString() === userInfo._id.toString()
    );

    if (!isMember) {
        logger.debug(`User ${userInfo._id.toString()} is not a member of channel ${channelId}`);
        throw apiValidationException("channel_not_yours", null, null, languageCode);
    }

    const isOwner = channel.owner.toString() === userInfo._id.toString();
    const isAdmin = (channel.adminUsers as unknown as IUser[]).some(
        (u: IUser) => u._id.toString() === userInfo._id.toString()
    );

    if (!isOwner && !isAdmin) {
        logger.debug(`User ${userInfo._id.toString()} is not owner or admin of channel ${channelId}`);
        throw apiValidationException("insufficient_permissions", null, null, languageCode);
    }

    const setDoc: UpdateQuery<IChannel>["$set"] = {
        lastAction: new Date()
    };
    if (description !== undefined) {
        setDoc.description = description;
    }

    logger.debug(`Updating channel description...`);
    await channelService.updateById(
        channel._id,
        {
            $set: setDoc
        } as UpdateQuery<IChannel>,
        { session, logger, languageCode, auditUserId: actionUserCtx.userId }
    );

    const updatedChannel = await channelService.findOne(
        { _id: channel._id },
        { session, logger, languageCode },
        [
            { path: "users", select: "_id username userProfile", populate: { path: "userProfile", select: "name surname" } },
            { path: "owner", select: "_id username userProfile", populate: { path: "userProfile", select: "name surname" } },
            { path: "adminUsers", select: "_id username userProfile", populate: { path: "userProfile", select: "name surname" } },
            { path: "company", select: "_id name" }
        ]
    );

    if (!updatedChannel) {
        throw apiValidationException("channel_not_found", null, null, languageCode);
    }

    try {
        const allUserIds = updatedChannel.users.map((user: IUser) => user._id.toString());
        logger.debug(`Sending CHANNEL_DESCRIPTION_UPDATED notification to ${allUserIds.length} user(s)...`);

        const websocketMessage: WebSocketMessage<UpdateChannelDescriptionFormResponseType> = {
            code: WebSocketMessageCodes.CHANNEL_DESCRIPTION_UPDATED,
            payload: {
                channelId: channelId,
                description: description
            },
            userIds: allUserIds
        }
        pushWebsocketMessage(websocketMessage);

        logger.debug(`CHANNEL_DESCRIPTION_UPDATED notification sent successfully`);
    } catch (e) {
        logger.debug(`Failed to send CHANNEL_DESCRIPTION_UPDATED notification: ${e}`);
    }

    logger.finish(`Successfully updated description for channel ${channelId}`);
    return {
        channelId: channelId,
        description: description
    };
}

/**
 * DELETE /api/user/chats/channels
 *
 * Deletes or leaves a channel. For group channels: if user is last member, deletes channel;
 * otherwise removes user and transfers ownership/admin if needed. For direct messages: deletes channel.
 * Supports soft delete (recovery) or permanent deletion based on configuration.
 *
 * @route DELETE /api/user/chats/channels
 * @access Private
 * @requires Transaction
 * @body {DeleteChannelFormType} - Channel ID to delete/leave
 * @returns {Promise<DeleteChannelFormResponseType>} Success message
 * 
 * @throws {apiValidationException} If channel not found or user doesn't have access
 * 
 * @remarks
 * - Group channels: if last member, deletes channel; otherwise removes user
 * - Direct messages: always deletes channel
 * - If user is only admin, promotes another user to admin
 * - If user is owner, transfers ownership to an admin or first remaining user
 * - Creates "user_left" notification message for group channels
 * - Soft delete (CHAT.ENABLE_RECOVERY=true) or permanent deletion
 * - SchemaGuard verifies delete permission for Channel model
 * - Changes are audited with actionUserCtx.userId as the actor
 */
router.delete(
    "",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 60}),
    validateFormZod(deleteChannelFormSchema),
    transactionHandler(),
    asyncHandler(deleteUserChannel)
);
type DeleteUserChannelType = TransactionRequiredParams & AuthenticatedMWType;
/**
 * Deletes or leaves a channel, handling ownership and admin transfers.
 *
 * @param params - Transaction, form, and authenticated parameters
 * @returns Success message
 */
async function deleteUserChannel(params: DeleteUserChannelType & DeleteChannelFormType): Promise<DeleteChannelFormResponseType> {
    const { logger, channelId, company, session, userInfo, languageCode, actionUserCtx, actionUserInfo } = params;

    logger.start(`Processing channel deletion/leave for channel ${channelId} by user ${userInfo._id.toString()}...`);
    SchemaGuard.checkModelPermission(Channel, "delete", actionUserCtx, languageCode);

    let notifyMessage: IMessage | null = null;

    logger.debug(`Fetching channel with access validation...`);
    const foundChannel = await channelService.findOne(
        {
            _id: new ObjectId(channelId),
            company: company._id,
            $or: [
                {
                    users: userInfo._id
                },
                {
                    isGroup: true,
                    leftUsers: { $elemMatch: { user: userInfo._id, showChannel: true } }
                }
            ],
            deleted: false
        },
        {
            session,
            logger,
            languageCode
        },
        [
            {
                path: "users",
                select: "_id"
            },
            {
                path: "adminUsers",
                select: "_id"
            },
            {
                path: "owner",
                select: "_id"
            },
            // {
            //     path: "leftUsers._id",
            //     select: "_id"
            // }
        ]
    );

    if (!foundChannel) {
        logger.debug(`Channel ${channelId} not found or user does not have access`);
        throw apiValidationException("channel_not_yours_to_delete", null, null, languageCode);
    }

    // The AI-assistant channel is permanent - it cannot be deleted or left.
    // (Clearing its message history is handled by the messages API instead.)
    if (foundChannel.isAiAssistant) {
        logger.debug(`Refusing to delete/leave AI-assistant channel ${channelId}`);
        throw apiValidationException("ai_channel_cannot_be_deleted", null, null, languageCode);
    }

    logger.debug(`Channel found: isGroup=${foundChannel.isGroup}, users count=${foundChannel.users.length}`);

    // Extract user IDs for notifications (must be done after null check)
    let notifyUsers = foundChannel.users.map((user: IUser) => user._id.toString());

    // Get remaining users after current user leaves (for group channels)
    let remainingUsers: IUser[] = [];

    if (foundChannel.isGroup) {
        logger.debug(`Processing group channel deletion/leave...`);

        // Get remaining users after current user leaves
        remainingUsers = foundChannel.users.filter((user) => user._id.toString() !== userInfo._id.toString());
        logger.debug(`Remaining users after leave: ${remainingUsers.length}`);

        if (remainingUsers.length === 0) {
            // Last user leaving - delete the channel
            logger.debug(`User is the last member - deleting channel...`);
            // Delete all messages in the channel first
            await messageService.deleteMany(
                { channel: new ObjectId(channelId) },
                { session, logger, languageCode, auditUserId: actionUserCtx.userId }
            );
            logger.debug(`Deleted all messages in channel`);

            // Delete the channel
            await channelService.deleteMany(
                {_id: channelId},
                { session, logger, languageCode, auditUserId: actionUserCtx.userId }
            );
            logger.debug(`Permanently deleted channel`);
        }
        else {
            // Other users remain - remove current user from channel
            logger.debug(`Other users remain - removing user from channel...`);

            // Determine new admin list
            const currentAdminIds = foundChannel.adminUsers.map((admin: IUser) => admin._id.toString());
            const isUserAdmin = currentAdminIds.includes(userInfo._id.toString());
            logger.debug(`User is admin: ${isUserAdmin}, current admins: ${currentAdminIds.length}`);

            let newAdminUsers: ObjectId[];

            // If user is the only admin, promote another user to admin
            if (currentAdminIds.length === 1 && isUserAdmin) {
                logger.debug(`User is the only admin - promoting another user to admin...`);
                const otherUser = remainingUsers.find((user: IUser) => !currentAdminIds.includes(user._id.toString()));

                if (!otherUser) {
                    // Fallback: if all remaining users are already admins, use first remaining user
                    logger.debug(`All remaining users are already admins - using first remaining user`);
                    newAdminUsers = remainingUsers.map((user: IUser) => user._id);
                } else {
                    logger.debug(`Promoting user ${otherUser._id.toString()} to admin`);
                    newAdminUsers = [...currentAdminIds.filter(id => id !== userInfo._id.toString()).map(id => new ObjectId(id)), otherUser._id];
                }
            }
            else {
                // Remove user from admin list, keep others
                logger.debug(`Removing user from admin list, keeping other admins`);
                newAdminUsers = currentAdminIds
                    .filter(id => id !== userInfo._id.toString())
                    .map(id => new ObjectId(id));
            }

            // Determine new owner if current user is owner
            const currentOwnerId = foundChannel.owner._id.toString();
            const isUserOwner = currentOwnerId === userInfo._id.toString();
            let newOwner: ObjectId;

            if (isUserOwner) {
                logger.debug(`User is owner - transferring ownership...`);
                if (newAdminUsers.length > 0) {
                    newOwner = newAdminUsers[0];
                    logger.debug(`Transferring ownership to admin ${newOwner.toString()}`);
                }
                else if (remainingUsers.length > 0) {
                    // Fallback: if no admins, transfer to first remaining user
                    newOwner = remainingUsers[0]._id;
                    logger.debug(`No admins available - transferring ownership to first remaining user ${newOwner.toString()}`);
                }
                else {
                    // This should never happen due to remainingUsers.length check above
                    throw apiValidationException("cannot_determine_new_owner", null, null, languageCode);
                }
            }
            else {
                newOwner = new ObjectId(currentOwnerId);
                logger.debug(`User is not owner - keeping current owner`);
            }

            // Check if user already left (in leftUsers array)
            const userAlreadyLeft = foundChannel.leftUsers?.some(leftUser => leftUser.user.toString() === userInfo._id.toString()) || false;
            logger.debug(`User already in leftUsers: ${userAlreadyLeft}`);

            // Build update query based on whether user already left
            const updateQuery: UpdateQuery<IChannel> = {
                $pull: {
                    users: userInfo._id,
                },
                $set: {
                    adminUsers: newAdminUsers,
                    owner: newOwner,
                    lastAction: new Date(),
                }
            };

            let arrayFilters: any[] | undefined = undefined;

            if (userAlreadyLeft) {
                logger.debug(`Updating existing leftUsers entry to hide channel...`);
                // Use array filter to update specific element in leftUsers array
                updateQuery.$set!["leftUsers.$[elem].showChannel"] = false;
                arrayFilters = [{ "elem.user": userInfo._id }];
            }
            else {
                logger.debug(`Creating notification message for user leaving...`);
                notifyMessage = await messageService.create(
                    {
                        sender: userInfo._id,
                        channel: new ObjectId(channelId),
                        text: EncryptString("user_left"),
                        type: "notification",
                        company: company._id,
                    } as unknown as Partial<IMessage>,
                    { session, logger, languageCode, auditUserId: actionUserCtx.userId }
                );
                logger.debug(`Created notification message ${notifyMessage._id.toString()}`);

                // Add user to leftUsers array
                updateQuery.$push = {
                    leftUsers: {
                        user: userInfo._id,
                        time: new Date(Date.now()),
                        showChannel: true
                    }
                };
            }

            logger.debug(`Updating channel: removing user, updating admins and owner...`);
            await channelService.updateByIdOrThrow(
                new ObjectId(channelId),
                updateQuery,
                {session, logger, languageCode, auditUserId: actionUserCtx.userId, arrayFilters: arrayFilters}
            );
            logger.debug(`Successfully updated channel after user leave`);
        }
    }
    else {
        // Direct message channel (non-group)
        logger.debug(`Processing direct message channel deletion...`);
        // Delete all messages in the channel first
        await messageService.deleteMany(
            { channel: new ObjectId(channelId) },
            { session, logger, languageCode, auditUserId: actionUserCtx.userId }
        );
        logger.debug(`Deleted all messages in channel`);

        // Delete the channel
        await channelService.deleteMany(
            {_id: channelId},
            { session, logger, languageCode, auditUserId: actionUserCtx.userId }
        );
        logger.debug(`Permanently deleted channel`);
    }


    let response: DeleteChannelFormResponseType = {
        channelId: channelId,
        userId: userInfo._id.toString(),
        messageId: notifyMessage?._id.toString()
    }

    // Send CHANNEL_DELETED or CHANNEL_UPDATED notification to all affected users
    try {
        const affectedUserIds = foundChannel.users.map((user: IUser) => user._id.toString()).filter(id => id !== actionUserInfo._id.toString());
        logger.debug(`Sending channel update notification to ${affectedUserIds.length} user(s)...`);
        
        if (foundChannel.isGroup) {
            // Group channel
            if (remainingUsers && remainingUsers.length > 0) {
                // User left but channel still exists - send CHANNEL_UPDATED to remaining members
                const updatedChannel = await channelService.findOne(
                    { _id: new ObjectId(channelId), company: company._id },
                    { session, logger, languageCode },
                    [
                        { path: "users", select: "_id username name surname photo" },
                        { path: "owner", select: "_id username name surname photo" },
                        { path: "adminUsers", select: "_id username name surname photo" },
                        { path: "company", select: "_id name" }
                    ]
                );
                
                if (updatedChannel) {
                    // Notify remaining members (excluding the user who left)
                    const remainingUserIds = remainingUsers.map((user: IUser) => user._id.toString());
                    const websocketMessage: WebSocketMessage<DeleteChannelFormResponseType> = {
                        code: WebSocketMessageCodes.CHANNEL_MEMBER_LEFT,
                        payload: response,
                        userIds: remainingUserIds
                    }
                    pushWebsocketMessage(websocketMessage);
                }
            }
            else {
                // Last user left - channel was deleted - notify all original members
                logger.debug(`Group channel deleted - notifying all ${affectedUserIds.length} original member(s)...`);
                const websocketMessage: WebSocketMessage<{channelId: string}> = {
                    code: WebSocketMessageCodes.CHANNEL_DELETED,
                    payload: {
                        channelId: channelId
                    },
                    userIds: affectedUserIds
                };
                pushWebsocketMessage(websocketMessage);
            }
        }
        else {
            // Direct message channel - notify BOTH users (deleter and other person) so chat disappears for both
            logger.debug(`Direct message channel deleted - notifying both users...`);
            const websocketMessage: WebSocketMessage<{channelId: string}> = {
                code: WebSocketMessageCodes.CHANNEL_DELETED,
                payload: {
                    channelId: channelId
                },
                userIds: affectedUserIds // Notify both users since the channel is a direct chat
            };
            pushWebsocketMessage(websocketMessage);
        }
        logger.debug(`Channel update notification sent successfully`);
    }
    catch (e) {
        logger.debug(`Failed to send channel update notification: ${e}`);
    }

    logger.finish(`Successfully processed channel deletion/leave!`);

    return {
        message: "Channel deleted",
        ...response
    };
}

export const basePath = '/api/user/chats/channels';
export { router };