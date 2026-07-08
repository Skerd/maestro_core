import {Router} from "express";
import {ObjectId} from "mongodb";
import {asyncHandler} from "@coreModule/utilities/middlewares/asyncHandler";
import authMW, {AuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import {transactionHandler} from "@coreModule/utilities/middlewares/transactionHandler";
import {TransactionRequiredParams} from "@coreModule/utilities/middlewares/transactionUtils";
import {
    MakeUserChannelAdminFormType
} from "armonia/src/modules/core/api/user/private/chats/channels/makeUserChannelAdmin.form.type";
import {
    MakeUserChannelAdminFormResponseType
} from "armonia/src/modules/core/api/user/private/chats/channels/makeUserChannelAdmin.form.response.type";
import {
    RemoveUserFromChannelAdminFormType
} from "armonia/src/modules/core/api/user/private/chats/channels/removeUserFromChannelAdmin.form.type";
import {
    RemoveUserFromChannelAdminFormResponseType
} from "armonia/src/modules/core/api/user/private/chats/channels/removeUserFromChannelAdmin.form.response.type";
import {channelService} from "@coreModule/database/schemas/channel/channel.service";
import {messageService} from "@coreModule/database/schemas/message/message.service";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {
    makeUserChannelAdminFormSchema
} from "armonia/src/modules/core/api/user/private/chats/channels/makeUserChannelAdmin.form.validator";
import {
    removeUserFromChannelAdminFormSchema
} from "armonia/src/modules/core/api/user/private/chats/channels/removeUserFromChannelAdmin.form.validator";
import {IUser} from "@coreModule/database/schemas/user/user";
import {IMessage} from "@coreModule/database/schemas/message/message";
import {EncryptString} from "@coreModule/utilities/security/encryption";
import SchemaGuard from "@coreModule/database/security/schemaGuard";
import {rateLimiter} from "@coreModule/utilities/middlewares/rateLimiter";
import {validateFormZod} from "@coreModule/utilities/middlewares/validateFormZod";
import Channel from "@coreModule/database/schemas/channel/channel";
import {WebSocketMessage, WebSocketMessageCodes} from "armonia/src/modules/core/websocket/types";
import {pushWebsocketMessage} from "@coreModule/domain/websocket/pushWebsocketMessage";

/**
 * Chat channel admin promotion and demotion (private).
 *
 * - PUT `/api/user/chats/channels/admins` — promote a member to admin (owner only, group channels).
 * - DELETE `/api/user/chats/channels/admins` — demote an admin (owner only; cannot remove last admin).
 *
 * Uses `schemaSanitizer` for channel write allowlist; writes are audited.
 *
 * @module user/private/chats/channels/admins
 */

const router = Router();

function buildChannelMemberFilter(channelId: string, companyId: ObjectId, userInfo: IUser) {
    return {
        _id: new ObjectId(channelId),
        company: companyId,
        users: userInfo._id,
        deleted: false
    };
}

/**
 * PUT /api/user/chats/channels/admins
 *
 * Promotes a channel member to admin. Only the channel owner can promote members to admin.
 * Target user must be a channel member and not already an admin.
 *
 * @route PUT /api/user/chats/channels/admins
 * @access Private
 * @requires Transaction
 * @body {MakeUserChannelAdminFormType} - Channel ID and user ID to promote
 * @returns {Promise<MakeUserChannelAdminFormResponseType>} Success message
 *
 * @throws {apiValidationException} If channel not found or user is not a member
 * @throws {apiValidationException} If user is not the channel owner
 * @throws {apiValidationException} If trying to make admin in non-group channel
 * @throws {apiValidationException} If target user is not a channel member
 * @throws {apiValidationException} If target user is already an admin
 *
 * @remarks
 * - Only group channels support admins
 * - Requires channel owner permissions
 * - Uses atomic update to prevent race conditions
 * - Changes are audited with actionUserCtx.userId as the actor
 */
router.put(
    "",
    authMW("private"),
    rateLimiter({
        windowMs: 60000,
        max: 60
    }),
    validateFormZod(makeUserChannelAdminFormSchema),
    transactionHandler(),
    asyncHandler(makeUserChannelAdmin)
);
type MakeUserChannelAdminType = TransactionRequiredParams & AuthenticatedMWType;
/**
 * Promotes a channel member to admin.
 *
 * @param params - Transaction, form, auth
 * @returns Success message
 */
async function makeUserChannelAdmin(params: MakeUserChannelAdminType & MakeUserChannelAdminFormType): Promise<MakeUserChannelAdminFormResponseType> {
    const { logger, channelId, userId, company, userInfo, session, languageCode, actionUserCtx, actionUserInfo } = params;

    logger.start(`Promoting user ${userId} to admin in channel ${channelId}...`);
    SchemaGuard.sanitizeFields(Channel, {adminUsers: {}}, "write", actionUserCtx, languageCode);

    logger.debug(`Fetching channel with membership validation...`);
    const foundChannel = await channelService.findOneOrThrow(
        buildChannelMemberFilter(channelId, company._id, userInfo),
        { session, logger, languageCode },
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
                path: "owner",
                select: "_id"
            }
        ]
    );

    logger.debug(`Channel found: isGroup=${foundChannel.isGroup}`);

    // Check ownership atomically with channel fetch to prevent race conditions
    const isUserOwner = foundChannel.owner._id.toString() === userInfo._id.toString();

    if (!isUserOwner) {
        logger.debug(`Validation failed: user is not the channel owner`);
        throw apiValidationException("only_channel_owner_can_make_users_admins", null, null, languageCode);
    }
    logger.debug(`User is confirmed as channel owner`);

    if (!foundChannel.isGroup) {
        logger.debug(`Validation failed: cannot make admin in non-group channel`);
        throw apiValidationException("cannot_make_admin_in_non_group_channel", null, null, languageCode);
    }

    // Note: Owner check is sufficient - owner should always be admin, but we check for consistency
    const isUserAdmin = foundChannel.adminUsers.some((admin) => admin._id.toString() === userInfo._id.toString());

    if (!isUserAdmin) {
        logger.debug(`Warning: Owner is not in admin list - this may indicate data inconsistency`);
        // Don't throw error, but log warning - owner should be admin
    }

    const targetUserId = new ObjectId(userId);
    const isTargetUserMember = foundChannel.users.some((user) => user._id.toString() === userId);

    if (!isTargetUserMember) {
        logger.debug(`Validation failed: target user is not a channel member`);
        throw apiValidationException("user_must_be_channel_member_to_become_admin", null, null, languageCode);
    }

    const isAlreadyAdmin = foundChannel.adminUsers.some((admin) => admin._id.toString() === userId);

    if (isAlreadyAdmin) {
        logger.debug(`Validation failed: user is already a channel admin`);
        throw apiValidationException("user_is_already_channel_admin", null, null, languageCode);
    }

    // Promote user to admin atomically with owner verification to prevent race conditions
    logger.debug(`Promoting user ${userId} to admin with atomic owner verification...`);
    const updateResult = await channelService.updateOne(
        {
            _id: new ObjectId(channelId),
            company: company._id,
            owner: userInfo._id, // User must still be the owner (atomic check)
            users: { $all: [userInfo._id, targetUserId] }, // Both current user and target user must be members
            isGroup: true,
            deleted: false,
            // Target user must not already be an admin
            adminUsers: { $ne: targetUserId }
        },
        {
            $addToSet: {
                adminUsers: targetUserId
            },
            $set: {
                lastAction: new Date()
            }
        },
        { session, logger, languageCode, auditUserId: actionUserCtx.userId }
    );

    if (updateResult.matchedCount === 0) {
        logger.debug(`Atomic update failed: channel not found, user is no longer owner, or target user is already admin/not a member`);
        throw apiValidationException("channel_not_found_or_permission_denied", null, null, languageCode);
    }
    logger.debug(`Successfully promoted user to admin (matched: ${updateResult.matchedCount}, modified: ${updateResult.modifiedCount})`);

    // Fetch updated channel to send CHANNEL_USER_PROMOTED_TO_ADMIN notification
    const updatedChannel = await channelService.findOneOrThrow(
        {
            _id: new ObjectId(channelId),
            company: company._id
        },
        { session, logger, languageCode },
        [
            { path: "users", select: "_id" },
        ]
    );

    const notificationMessage = await messageService.create(
        {
            sender: userInfo._id,
            receiver: targetUserId,
            channel: new ObjectId(channelId),
            text: EncryptString("user_made_admin"),
            type: "notification",
            company: company._id
        } as unknown as Partial<IMessage>,
        { session, logger, languageCode, auditUserId: actionUserCtx.userId }
    );

    const response = {
        channelId: updatedChannel._id.toString(),
        userId: userId,
        messageId: notificationMessage._id.toString()
    }

    try {
        const allUserIds = updatedChannel.users.map((user: IUser) => user._id.toString()).filter((userId) => userId !== actionUserInfo._id.toString());
        logger.debug(`Sending CHANNEL_USER_PROMOTED_TO_ADMIN notification to ${allUserIds.length} user(s)...`);

        const websocketMessage: WebSocketMessage<MakeUserChannelAdminFormResponseType> = {
            code: WebSocketMessageCodes.CHANNEL_USER_PROMOTED_TO_ADMIN,
            payload: response,
            userIds: allUserIds
        }
        pushWebsocketMessage(websocketMessage);

        logger.debug(`CHANNEL_USER_PROMOTED_TO_ADMIN notification sent successfully`);
    }
    catch (e) {
        logger.debug(`Failed to send CHANNEL_USER_PROMOTED_TO_ADMIN notification: ${e}`);
    }

    logger.finish(`User ${userId} promoted to channel admin successfully!`);

    return {
        message: "User promoted to channel admin successfully",
        ...response
    };
}

/**
 * DELETE /api/user/chats/channels/admins
 *
 * Demotes a channel admin back to regular member. Only the channel owner can demote admins.
 * Cannot demote the last admin (channel must have at least one admin).
 *
 * @route DELETE /api/user/chats/channels/admins
 * @access Private
 * @requires Transaction
 * @body {RemoveUserFromChannelAdminFormType} - Channel ID and user ID to demote
 * @returns {Promise<RemoveUserFromChannelAdminFormResponseType>} Success message
 *
 * @throws {apiValidationException} If channel not found or user is not a member
 * @throws {apiValidationException} If user is not the channel owner
 * @throws {apiValidationException} If trying to remove admin from non-group channel
 * @throws {apiValidationException} If target user is not a channel admin
 * @throws {apiValidationException} If trying to remove the last channel admin
 *
 * @remarks
 * - Only group channels support admins
 * - Requires channel owner permissions
 * - Channel must have at least one admin (cannot remove last admin)
 * - Uses atomic update with admin count check to prevent race conditions
 * - SchemaGuard verifies write permission for Channel.adminUsers field
 * - Changes are audited with actionUserCtx.userId as the actor
 */
router.delete(
    "",
    authMW("private"),
    rateLimiter({
        windowMs: 60000,
        max: 60
    }),
    validateFormZod(removeUserFromChannelAdminFormSchema),
    transactionHandler(),
    asyncHandler(removeUserFromChannelAdmin)
);
type RemoveUserFromChannelAdminType = TransactionRequiredParams & AuthenticatedMWType;
/**
 * Demotes a channel admin back to regular member.
 *
 * @param params - Transaction, form, auth
 * @returns Success message
 */
async function removeUserFromChannelAdmin(params: RemoveUserFromChannelAdminType & RemoveUserFromChannelAdminFormType): Promise<RemoveUserFromChannelAdminFormResponseType> {
    const { logger, channelId, userId, company, userInfo, session, languageCode, actionUserCtx, actionUserInfo } = params;

    logger.start(`Demoting user ${userId} from admin in channel ${channelId}...`);
    SchemaGuard.sanitizeFields(Channel, {adminUsers: {}}, "write", actionUserCtx, languageCode);

    logger.debug(`Fetching channel with membership validation...`);
    const foundChannel = await channelService.findOneOrThrow(
        buildChannelMemberFilter(channelId, company._id, userInfo),
        { session, logger, languageCode },
        [
            {
                path: "adminUsers",
                select: "_id"
            },
            {
                path: "owner",
                select: "_id"
            }
        ]
    );

    logger.debug(`Channel found: isGroup=${foundChannel.isGroup}, admin count=${foundChannel.adminUsers.length}`);

    // Check ownership atomically with channel fetch to prevent race conditions
    const isUserOwner = foundChannel.owner._id.toString() === userInfo._id.toString();

    if (!isUserOwner) {
        logger.debug(`Validation failed: user is not the channel owner`);
        throw apiValidationException("only_channel_owner_can_demote_users", null, null, languageCode);
    }
    logger.debug(`User is confirmed as channel owner`);

    if (!foundChannel.isGroup) {
        logger.debug(`Validation failed: cannot remove admin from non-group channel`);
        throw apiValidationException("cannot_remove_admin_from_non_group_channel", null, null, languageCode);
    }

    // Note: Owner check is sufficient - owner should always be admin, but we check for consistency
    const isUserAdmin = foundChannel.adminUsers.some((admin: IUser) => admin._id.toString() === userInfo._id.toString());

    if (!isUserAdmin) {
        logger.debug(`Warning: Owner is not in admin list - this may indicate data inconsistency`);
        // Don't throw error, but log warning - owner should be admin
    }

    const isTargetUserAdmin = foundChannel.adminUsers.some((admin) => admin._id.toString() === userId);

    if (!isTargetUserAdmin) {
        logger.debug(`Validation failed: target user is not a channel admin`);
        throw apiValidationException("user_is_not_channel_admin", null, null, languageCode);
    }

    // Cannot remove the last admin - channel must have at least one admin
    if (foundChannel.adminUsers.length === 1) {
        logger.debug(`Validation failed: cannot remove the last channel admin`);
        throw apiValidationException("cannot_remove_last_channel_admin", null, null, languageCode);
    }

    const targetUserId = new ObjectId(userId);

    // Demote user from admin atomically with owner verification and admin count check to prevent race conditions
    logger.debug(`Demoting user ${userId} from admin with atomic owner verification and admin count check...`);
    const updateResult = await channelService.updateOne(
        {
            _id: new ObjectId(channelId),
            company: company._id,
            owner: userInfo._id, // User must still be the owner (atomic check)
            users: userInfo._id, // User must still be a member
            isGroup: true,
            deleted: false,
            // Target user must still be an admin
            adminUsers: targetUserId,
            // Ensure there's more than one admin (cannot remove last admin)
            $expr: { $gt: [{ $size: "$adminUsers" }, 1] }
        },
        {
            $pull: {
                adminUsers: targetUserId
            },
            $set: {
                lastAction: new Date()
            }
        },
        { session, logger, languageCode, auditUserId: actionUserCtx.userId }
    );

    if (updateResult.matchedCount === 0) {
        logger.debug(`Atomic update failed: channel not found, user is no longer owner, target is not admin, or only one admin remains`);
        throw apiValidationException("channel_not_found_or_permission_denied", null, null, languageCode);
    }
    logger.debug(`Successfully demoted user from admin (matched: ${updateResult.matchedCount}, modified: ${updateResult.modifiedCount})`);

    // Fetch the updated channel to send CHANNEL_USER_DEMOTED_FROM_ADMIN notification
    const updatedChannel = await channelService.findOneOrThrow(
        {
            _id: new ObjectId(channelId),
            company: company._id
        },
        { session, logger, languageCode },
        [
            { path: "users", select: "_id" }
        ]
    );

    const notificationMessage = await messageService.create(
        {
            sender: userInfo._id,
            receiver: targetUserId,
            channel: new ObjectId(channelId),
            company: company._id,
            text: EncryptString("user_demoted_from_admin"),
            type: "notification"
        } as unknown as Partial<IMessage>,
        { session, logger, languageCode, auditUserId: actionUserCtx.userId }
    );

    const response = {
        channelId: updatedChannel._id.toString(),
        userId: userId,
        messageId: notificationMessage._id.toString()
    }

    try {
        const allUserIds = updatedChannel.users.map((user: IUser) => user._id.toString()).filter((userId) => userId !== actionUserInfo._id.toString());
        logger.debug(`Sending CHANNEL_USER_DEMOTED_FROM_ADMIN notification to ${allUserIds.length} user(s)...`);

        const websocketMessage: WebSocketMessage<RemoveUserFromChannelAdminFormResponseType> = {
            code: WebSocketMessageCodes.CHANNEL_USER_DEMOTED_FROM_ADMIN,
            payload: response,
            userIds: allUserIds
        }
        pushWebsocketMessage(websocketMessage);

        logger.debug(`CHANNEL_USER_DEMOTED_FROM_ADMIN notification sent successfully`);
    }
    catch (e) {
        logger.debug(`Failed to send CHANNEL_USER_DEMOTED_FROM_ADMIN notification: ${e}`);
    }

    logger.finish(`User ${userId} demoted from channel admin successfully!`);

    return {
        message: "User removed from channel admin successfully",
        ...response
    };
}

export { router };