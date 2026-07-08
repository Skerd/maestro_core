import {Router} from "express";
import {ObjectId} from "mongodb";
import {asyncHandler} from "@coreModule/utilities/middlewares/asyncHandler";
import authMW, {AuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import {transactionHandler} from "@coreModule/utilities/middlewares/transactionHandler";
import {TransactionRequiredParams} from "@coreModule/utilities/middlewares/transactionUtils";
import {
    AllChannelMembersFormType
} from "armonia/src/modules/core/api/user/private/chats/channels/allChannelMembers.form.type";
import {
    AllChannelMembersFormResponseType
} from "armonia/src/modules/core/api/user/private/chats/channels/allChannelMembers.form.response.type";
import {
    AddChannelMembersFormType
} from "armonia/src/modules/core/api/user/private/chats/channels/addChannelMembers.form.type";
import {
    RemoveChannelMembersFormType
} from "armonia/src/modules/core/api/user/private/chats/channels/removeChannelMembers.form.type";
import {channelService} from "@coreModule/database/schemas/channel/channel.service";
import {messageService} from "@coreModule/database/schemas/message/message.service";
import {userService} from "@coreModule/database/schemas/user/user.service";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {
    allChannelMembersFormSchema
} from "armonia/src/modules/core/api/user/private/chats/channels/allChannelMembers.form.validator";
import {
    addChannelMembersFormSchema
} from "armonia/src/modules/core/api/user/private/chats/channels/addChannelMembers.form.validator";
import {
    removeChannelMembersFormSchema
} from "armonia/src/modules/core/api/user/private/chats/channels/removeChannelMembers.form.validator";
import {IUser} from "@coreModule/database/schemas/user/user";
import Channel from "@coreModule/database/schemas/channel/channel";
import {IMessage} from "@coreModule/database/schemas/message/message";
import {EncryptString} from "@coreModule/utilities/security/encryption";
import {ChannelUser} from "armonia/src/modules/core/types";
import SchemaGuard from "@coreModule/database/security/schemaGuard";
import {rateLimiter} from "@coreModule/utilities/middlewares/rateLimiter";
import {validateFormZod} from "@coreModule/utilities/middlewares/validateFormZod";
import {schemaSanitizer, SchemaSanitizerMWType} from "@coreModule/utilities/middlewares/schemaSanitizerMW";
import {
    AddChannelMembersFormResponseType
} from "armonia/src/modules/core/api/user/private/chats/channels/addChannelMembers.form.response.type";
import {
    RemoveChannelMembersFormResponseType
} from "armonia/src/modules/core/api/user/private/chats/channels/removeChannelMembers.form.response.type";
import {WebSocketMessage, WebSocketMessageCodes} from "armonia/src/modules/core/websocket/types";
import {pushWebsocketMessage} from "@coreModule/domain/websocket/pushWebsocketMessage";

const router = Router();

/**
 * POST /api/user/chats/channels/members
 *
 * Fetches all members of a channel with their roles (user/admin/owner). User must be
 * an active member of the channel to view members.
 *
 * @route POST /api/user/chats/channels/members
 * @access Private
 * @body {AllChannelMembersFormType} - Channel ID
 * @returns {Promise<AllChannelMembersFormResponseType>} List of channel members with roles
 *
 * @throws {apiValidationException} If channel not found or user is not a member
 *
 * @remarks
 * - Read-only operation - no database writes occur
 * - Returns members with userType: "user", "admin", or "owner"
 * - Fields are filtered based on user's read permissions via schemaSanitizer
 * - No audit logging needed as no changes are made
 */
router.post(
    "",
    authMW("private"),
    rateLimiter({
        windowMs: 60000,
        max: 60
    }),
    validateFormZod(allChannelMembersFormSchema),
    schemaSanitizer({model: "channels", requiredModes: ["read"]}),
    asyncHandler(getChannelMembers)
);
type GetChannelMembersType = AuthenticatedMWType & SchemaSanitizerMWType;
/**
 * Fetches channel members with their roles.
 *
 * @param params - Form, auth, sanitizedReadFields
 * @returns List of channel members
 */
async function getChannelMembers(params: GetChannelMembersType & AllChannelMembersFormType): Promise<AllChannelMembersFormResponseType> {
    const { logger, channelId, company, userInfo, languageCode, sanitizedReadFields} = params;

    logger.start(`Fetching members for channel ${channelId}...`);
    const populate = SchemaGuard.generatePopulate(sanitizedReadFields, Channel.schema);

    logger.debug(`Fetching channel with membership validation...`);
    const foundChannel = await channelService.findOneOrThrow(
        {
            _id: new ObjectId(channelId),
            company: company._id,
            users: userInfo._id,
            deleted: false
        },
        { logger, languageCode },
        populate.populate,
        (populate.select || "")
    );

    logger.debug(`Channel found with ${foundChannel.users.length} member(s)`);
    // Create set of admin user IDs for efficient lookup
    const adminUserIds = new Set((foundChannel.adminUsers || []).map((admin: IUser) => admin._id.toString()));
    logger.debug(`Found ${adminUserIds.size} admin(s)`);

    // Map users to ChannelUser format with admin status
    logger.debug(`Mapping users to response format...`);
    const members: ChannelUser[] = (foundChannel.users || []).map((user: IUser) => {

        const userId = user._id.toString();

        let userType: "user" | "admin" | "owner" | undefined = "user";
        if( !!foundChannel.adminUsers && !!foundChannel.adminUsers?.length ){
            if( (foundChannel.adminUsers || []).some(admin => admin._id.toString() === userId) ){
                userType = "admin";
            }
        }
        if( !!foundChannel.owner ){
            if( foundChannel.owner._id.toString() === userId ){
                userType = "owner";
            }
        }
        if( !foundChannel.adminUsers && !foundChannel.owner ){
            userType = undefined;
        }

        return {
            _id: userId,
            name: user?.name,
            surname: user?.surname,
            photo: user?.photo?._id.toString(),
            userType
        };
    });

    logger.finish(`Successfully fetched ${members.length} channel member(s)!`);

    return {
        members
    };
}

/**
 * PUT /api/user/chats/channels/members
 *
 * Adds members to a group channel. Only channel admins can add members. Validates all
 * users exist and belong to company. Creates notification messages for added users.
 *
 * @route PUT /api/user/chats/channels/members
 * @access Private
 * @requires Transaction
 * @body {AddChannelMembersFormType} - Channel ID and user IDs to add
 * @returns {Promise<AddChannelMembersFormResponseType>} Updated channel information
 *
 * @throws {apiValidationException} If channel not found or user is not a member
 * @throws {apiValidationException} If user is not a channel admin
 * @throws {apiValidationException} If trying to add members to non-group channel
 * @throws {apiValidationException} If one or more users not found
 * @throws {apiValidationException} If all users already in channel
 *
 * @remarks
 * - Only group channels support adding members
 * - Requires channel admin permissions
 * - Removes users from leftUsers array if they had left previously
 * - Creates "user_added" notification messages for each added user (IDs only over WebSocket on CHANNEL_MEMBER_ADDED)
 * - Uses atomic update to prevent race conditions
 * - SchemaGuard verifies write permission for Channel.users field
 * - Changes are audited with actionUserCtx.userId as the actor
 */
router.put(
    "",
    authMW("private"),
    rateLimiter({
        windowMs: 60000,
        max: 60
    }),
    validateFormZod(addChannelMembersFormSchema),
    schemaSanitizer({model: "channels", requiredModes: ["read"]}),
    transactionHandler(),
    asyncHandler(addChannelMembers)
);
type AddChannelMembersType = TransactionRequiredParams & AuthenticatedMWType & SchemaSanitizerMWType;
/**
 * Adds members to a group channel.
 *
 * @param params - Transaction, form, auth
 * @returns Updated channel information
 */
async function addChannelMembers(params: AddChannelMembersType & AddChannelMembersFormType): Promise<AddChannelMembersFormResponseType> {
    const { logger, channelId, userIds, company, userInfo, session, languageCode, actionUserCtx, sanitizedReadFields, actionUserInfo } = params;

    logger.start(`Adding ${userIds.length} member(s) to channel ${channelId}...`);
    SchemaGuard.sanitizeFields(Channel, {users: {}}, "write", actionUserCtx, languageCode);

    logger.debug(`Fetching channel with membership and admin validation...`);
    const foundChannel = await channelService.findOneOrThrow(
        {
            _id: new ObjectId(channelId),
            company: company._id,
            users: userInfo._id,
            deleted: false
        },
        {session, logger, languageCode},
        [
            {
                path: "adminUsers",
                select: "_id"
            },
            {
                path: "users",
                select: "_id"
            },
            {
                path: "leftUsers",
                select: "user"
            }
        ]
    );
    logger.debug(`Channel found: isGroup=${foundChannel.isGroup}, current members=${foundChannel.users.length}`);

    if (!foundChannel.isGroup) {
        logger.debug(`Validation failed: cannot add members to non-group channel`);
        throw apiValidationException("cannot_add_members_to_non_group_channel", null, null, languageCode);
    }

    // Check admin status atomically with channel fetch to prevent race conditions
    if (!foundChannel.adminUsers?.some((admin) => admin._id.toString() === userInfo._id.toString())) {
        throw apiValidationException("only_channel_admin_can_add_members", null, null, languageCode);
    }
    logger.debug(`User is confirmed as channel admin`);

    const usersObjectIds = userIds.map(id => new ObjectId(id));
    const filteredUserIds = userIds.filter(id => id !== userInfo._id.toString());

    if (filteredUserIds.length === 0) {
        logger.debug(`Validation failed: must add at least one other user`);
        throw apiValidationException("must_add_at_least_one_other_user", null, null, languageCode);
    }

    // Uses indexes on User._id and UserProfile.companies for fast lookups
    logger.debug(`Validating that all ${userIds.length} user(s) exist and belong to company...`);

    const foundUsers = await userService.find({
        _id: {
            $in: usersObjectIds
        },
        companies: company._id,
        "roles.company": company._id,
        "roles.active": "active",
    }, { session, logger, languageCode })

    if (foundUsers.length !== userIds.length) {
        logger.debug(`Validation failed: found ${foundUsers.length} users, expected ${userIds.length}`);
        throw apiValidationException("one_of_the_users_not_found", null, null, languageCode);
    }
    logger.debug(`All ${foundUsers.length} user(s) validated successfully`);

    // Check if users are already in the channel
    const existingUserIds = foundChannel.users.map((user) => user._id.toString());
    const newUserIds = userIds.filter(id => !existingUserIds.includes(id));
    logger.debug(`New users to add: ${newUserIds.length} (${newUserIds.length === 0 ? 'none' : newUserIds.join(', ')})`);

    if (newUserIds.length === 0) {
        logger.debug(`Validation failed: all users are already in the channel`);
        throw apiValidationException("all_users_already_in_channel", null, null, languageCode);
    }

    const foundNewUsers = await userService.find({_id: {$in: newUserIds.map(id => new ObjectId(id))}}, { session, logger, languageCode});

    // Add users to channel atomically with admin verification to prevent race conditions
    logger.debug(`Adding ${newUserIds.length} user(s) to channel with atomic admin verification...`);
    const updateResult = await channelService.updateOne(
        {
            _id: new ObjectId(channelId),
            company: company._id,
            users: userInfo._id, // User must still be a member
            adminUsers: userInfo._id, // User must still be an admin (atomic check)
            isGroup: true,
            deleted: false
        },
        {
            $addToSet: {
                users: { $each: newUserIds.map(id => new ObjectId(id)) }
            },
            $pull: {
                leftUsers: {
                    user: { $in: usersObjectIds }
                },
            },
            $set: {
                lastAction: new Date()
            }
        },
        { session, logger, languageCode, auditUserId: actionUserCtx.userId }
    );

    if (updateResult.matchedCount === 0) {
        logger.debug(`Atomic update failed: channel not found or user is no longer admin/member`);
        throw apiValidationException("channel_not_found_or_permission_denied", null, null, languageCode);
    }
    logger.debug(`Successfully added users to channel (matched: ${updateResult.matchedCount}, modified: ${updateResult.modifiedCount})`);

    const newMessages = await messageService.createMany(
        foundNewUsers.map((user): Partial<IMessage> => {
            return ({
                sender: userInfo,
                receiver: user,
                channel: foundChannel,
                text: EncryptString("user_added"),
                type: "notification",
                company: company._id,
            })
        }),
        { session, logger, languageCode, auditUserId: actionUserCtx.userId }
    );

    const populate = SchemaGuard.generatePopulate(sanitizedReadFields, Channel.schema);
    const updatedChannel = await channelService.findByIdOrThrow(
        foundChannel._id,
        { session, logger, languageCode },
        populate.populate,
        populate.select
    )

    let response: AddChannelMembersFormResponseType = {
        channelId: updatedChannel._id.toString(),
        messageIds: newMessages.map((message) => message._id.toString()),
        addedMembers: newUserIds.map((userId) => ({
            _id: userId,
            status: foundChannel.leftUsers?.some((leftUser) => leftUser.user._id?.toString() === userId) ? "historical" : "new"
        }))
    }

    // Send CHANNEL_MEMBER_ADDED notification to all channel members
    try {
        const allUserIds = updatedChannel.users.map((user: IUser) => user._id.toString()).filter((userId) => userId !== actionUserInfo._id.toString());
        logger.debug(`Sending CHANNEL_MEMBER_ADDED notification to ${allUserIds.length} user(s)...`);

        const websocketMessage: WebSocketMessage<AddChannelMembersFormResponseType> = {
            code: WebSocketMessageCodes.CHANNEL_MEMBER_ADDED,
            payload: response,
            userIds: allUserIds
        }
        pushWebsocketMessage(websocketMessage);

        logger.debug(`CHANNEL_MEMBER_ADDED notification sent successfully`);
    } catch (e) {
        logger.debug(`Failed to send CHANNEL_MEMBER_ADDED notification: ${e}`);
    }

    logger.finish(`Successfully added ${newUserIds.length} member(s) to channel!`);

    return {
        message: "Members added successfully",
        ...response
    };
}

/**
 * DELETE /api/user/chats/channels/members
 *
 * Removes members from a group channel. Only channel admins can remove members. Cannot
 * remove owner or yourself. Creates notification messages for removed users.
 *
 * @route DELETE /api/user/chats/channels/members
 * @access Private
 * @requires Transaction
 * @body {RemoveChannelMembersFormType} - Channel ID and user IDs to remove
 * @returns {Promise<RemoveChannelMembersFormResponseType>} Updated channel information
 *
 * @throws {apiValidationException} If channel not found or user is not a member
 * @throws {apiValidationException} If user is not a channel admin
 * @throws {apiValidationException} If trying to remove members from non-group channel
 * @throws {apiValidationException} If trying to remove owner
 * @throws {apiValidationException} If trying to remove yourself
 * @throws {apiValidationException} If one or more users not in channel
 *
 * @remarks
 * - Only group channels support removing members
 * - Requires channel admin permissions
 * - Removes users from adminUsers array if they were admins
 * - Adds users to leftUsers array
 * - Creates "user_removed" notification messages for each removed user (IDs on CHANNEL_MEMBER_REMOVED)
 * - Uses atomic update to prevent race conditions
 * - SchemaGuard verifies write permission for Channel.users field
 * - Changes are audited with actionUserCtx.userId as the actor
 */
router.delete(
    "",
    authMW("private"),
    rateLimiter({
        windowMs: 60000,
        max: 60
    }),
    validateFormZod(removeChannelMembersFormSchema),
    transactionHandler(),
    asyncHandler(removeChannelMembers)
);
type RemoveChannelMembersType = TransactionRequiredParams & AuthenticatedMWType ;
/**
 * Removes members from a group channel.
 *
 * @param params - Transaction, form, auth
 * @returns Updated channel information
 */
async function removeChannelMembers(params: RemoveChannelMembersType & RemoveChannelMembersFormType): Promise<RemoveChannelMembersFormResponseType> {
    const { logger, channelId, userIds, company, userInfo, session, languageCode, actionUserCtx, actionUserInfo} = params;

    logger.start(`Removing ${userIds.length} member(s) from channel ${channelId}...`);
    SchemaGuard.sanitizeFields(Channel, {users: {}}, "write", actionUserCtx, languageCode);

    logger.debug(`Fetching channel with membership and admin validation...`);
    const foundChannel = await channelService.findOneOrThrow(
        {
            _id: new ObjectId(channelId),
            company: company._id,
            users: userInfo._id,
            deleted: false
        },
        { session, logger, languageCode },
        [
            {
                path: "owner",
                select: "_id"
            },
            {
                path: "adminUsers",
                select: "_id"
            },
            {
                path: "users",
                select: "_id"
            }
        ]
    );

    logger.debug(`Channel found: isGroup=${foundChannel.isGroup}, current members=${foundChannel.users.length}`);

    if (!foundChannel.isGroup) {
        logger.debug(`Validation failed: cannot remove members from non-group channel`);
        throw apiValidationException("cannot_remove_members_from_non_group_channel", null, null, languageCode);
    }

    // Check admin status atomically with channel fetch to prevent race conditions
    if (!foundChannel.adminUsers?.some((admin) => admin._id.toString() === userInfo._id.toString())) {
        throw apiValidationException("only_channel_admin_can_remove_members", null, null, languageCode);
    }
    logger.debug(`User is confirmed as channel admin`);

    // Users cannot remove themselves
    if (userIds.includes(userInfo._id.toString())) {
        logger.debug(`Validation failed: user cannot remove themselves`);
        throw apiValidationException("cannot_remove_yourself_use_delete_channel", null, null, languageCode);
    }

    //Users cannot remove owner
    if( userIds.includes(foundChannel.owner._id.toString()) ){
        logger.debug(`Validation failed: User cannot remove owner`);
        throw apiValidationException("cannot_remove_owner_from_group_channel", null, null, languageCode);
    }

    // All users must be in the channel as active users
    const currentChannelUserIds = foundChannel.users.map((user) => user._id.toString());
    const invalidUserIds = userIds.filter(userId => !currentChannelUserIds.includes(userId));

    if (invalidUserIds.length > 0) {
        logger.debug(`Validation failed: users not in channel: ${invalidUserIds.join(', ')}`);
        throw apiValidationException("all_member_to_delete_must_be_part_of_channel", null, null, languageCode);
    }

    if (userIds.length > foundChannel.users.length) {
        logger.debug(`Validation failed: trying to remove more users than exist in channel`);
        throw apiValidationException("all_member_to_delete_must_be_part_of_channel", null, null, languageCode);
    }

    const usersObjectIds = userIds.map(id => new ObjectId(id));
    const foundUsers = await userService.find({_id: {$in: usersObjectIds}}, { session, logger, languageCode});

    // Remove users from channel and admin list atomically with admin verification to prevent race conditions
    logger.debug(`Removing ${usersObjectIds.length} user(s) from channel and admin list with atomic admin verification...`);
    const updateResult = await channelService.updateOne(
        {
            _id: new ObjectId(channelId),
            company: company._id,
            users: { $all: [userInfo._id, ...usersObjectIds] }, // User must be member AND all users to remove must be in channel
            adminUsers: userInfo._id, // User must still be an admin (atomic check)
            isGroup: true,
            deleted: false
        },
        {
            $pull: {
                users: { $in: usersObjectIds },
                adminUsers: { $in: usersObjectIds }
            },
            $push: {
                leftUsers: {
                    $each: usersObjectIds.map(userId => ({
                        user: userId,
                        time: new Date(),
                        showChannel: true
                    }))
                }
            },
            $set: {
                lastAction: new Date()
            }
        },
        { session, logger, languageCode, auditUserId: actionUserCtx.userId }
    );

    if (updateResult.matchedCount === 0) {
        logger.debug(`Atomic update failed: channel not found, user is no longer admin/member, or users no longer in channel`);
        throw apiValidationException("channel_not_found_or_permission_denied", null, null, languageCode);
    }
    logger.debug(`Successfully removed users from channel (matched: ${updateResult.matchedCount}, modified: ${updateResult.modifiedCount})`);


    const newMessages = await messageService.createMany(
        foundUsers.map((user): Partial<IMessage> => {
            return ({
                sender: userInfo,
                receiver: user,
                channel: foundChannel,
                text: EncryptString("user_removed"),
                type: "notification",
                company: foundChannel.company
            })
        }),
        { session, logger, languageCode, auditUserId: actionUserCtx.userId }
    );

    const updatedChannel = await channelService.findByIdOrThrow(
        foundChannel._id,
        { session, logger, languageCode },
        [
            {
                path: "users",
                select: "_id",
            }
        ],
        "users"
    )

    const response = {
        channelId: updatedChannel._id.toString(),
        messageIds: newMessages.map((message) => message._id.toString()),
        removedMembers: usersObjectIds.map((user) => user._id.toString())
    }

    // Send CHANNEL_MEMBER_REMOVED notification to all remaining channel members
    try {
        const allUserIds = foundChannel.users.map((user: IUser) => user._id.toString()).filter((userId) => userId !== actionUserInfo._id.toString() );
        logger.debug(`Sending CHANNEL_MEMBER_REMOVED notification to ${allUserIds.length} user(s)...`);

        const websocketMessage: WebSocketMessage<RemoveChannelMembersFormResponseType> = {
            code: WebSocketMessageCodes.CHANNEL_MEMBER_REMOVED,
            payload: response,
            userIds: allUserIds
        }
        pushWebsocketMessage(websocketMessage);

        logger.debug(`CHANNEL_MEMBER_REMOVED notification sent successfully`);
    } catch (e) {
        logger.debug(`Failed to send CHANNEL_MEMBER_REMOVED notification: ${e}`);
    }

    logger.finish(`Successfully removed ${usersObjectIds.length} member(s) from channel!`);

    return {
        message: "Members removed successfully",
        ...response
    };
}

export { router };