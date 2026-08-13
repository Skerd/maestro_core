import {ObjectId} from "mongodb";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {channelService} from "@coreModule/database/schemas/channel/channel.service";
import {messageService} from "@coreModule/database/schemas/message/message.service";
import type {IUser} from "@coreModule/database/schemas/user/user";
import type {IChannel} from "@coreModule/database/schemas/channel/channel";
import type {ICompany} from "@coreModule/database/schemas/company/company";
import type {IMessage} from "@coreModule/database/schemas/message/message";
import type {AuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";

const channelPopulate = [
    {path: "users", select: "_id name surname photo"},
    {
        path: "leftUsers",
        select: "user time",
        populate: {path: "user", select: "_id"}
    }
];

/**
 * Channel visibility for reading messages: current members, left-but-visible groups,
 * waiting public chats (`requested_human`, unassigned) so agents can peek before joining,
 * or any company public chat (e.g. opening a lead's linked website conversation).
 * Mutating a message still requires membership (pin, react, send).
 */
export function channelMessageReadFilter(userId: ObjectId) {
    return {
        $or: [
            {users: userId},
            {
                isGroup: true,
                leftUsers: {
                    $elemMatch: {
                        user: userId,
                        showChannel: true
                    }
                }
            },
            {
                isPublicChat: true,
            }
        ]
    };
}

export function isChannelMember(channel: IChannel, userId: ObjectId): boolean {
    const id = userId.toString();
    return (channel.users || []).some((u) => {
        const uid = u && typeof u === "object" && "_id" in u
            ? (u as {_id: ObjectId})._id.toString()
            : String(u);
        return uid === id;
    });
}

/**
 * Loads a message and verifies the user is a **member** of its channel (same company).
 * Waiting-chat peek is not enough — pin/react still require membership.
 */
export async function loadMessageAndChannelForReadAccess(messageId: string, userInfo: IUser, company: ICompany, languageCode: string, logger: AuthenticatedMWType["logger"]): Promise<{message: IMessage; channel: IChannel}> {
    const messageProbe = await messageService.findOneOrThrow(
        {_id: new ObjectId(messageId)},
        {logger, languageCode}
    );

    if (messageProbe.status === "deleted") {
        throw apiValidationException("message_not_found_or_not_yours", null, null, languageCode);
    }

    const channelId = messageProbe.channel instanceof ObjectId ? messageProbe.channel : (messageProbe.channel as IChannel)._id;
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
        channelPopulate
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

    return {message: messageProbe, channel: selectedChannel};
}
