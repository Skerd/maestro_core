import {ObjectId} from "mongodb";
import Channel from "@coreModule/database/schemas/channel/channel";
import Message from "@coreModule/database/schemas/message/message";
import LastChannelReadMessage from "@coreModule/database/schemas/lastChannelReadMessage/lastChannelReadMessage";
import type {InboxBadgesFormResponseType} from "armonia/src/modules/core/api/user/private/chats/channels/inboxBadges.form.response.type";
import type {PublicChatStatusType} from "armonia/src/modules/core/api/user/public/publicChat/publicChat.types";

const UNREAD_OR_CHUNK = 200;

type ChannelUnreadMeta = {
    _id: ObjectId;
    isPublicChat?: boolean;
    publicChat?: {status?: PublicChatStatusType};
};

function membershipMatch(companyId: ObjectId, userId: ObjectId) {
    return {
        company: companyId,
        deleted: false,
        $or: [
            {users: userId},
            {
                leftUsers: {
                    $elemMatch: {
                        user: userId,
                        showChannel: true,
                    },
                },
            },
        ],
    };
}

async function unreadCountsForChannels(channelIds: ObjectId[], userId: ObjectId): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (channelIds.length === 0) {
        return counts;
    }

    const reads = await LastChannelReadMessage.find({
        user: userId,
        channel: {$in: channelIds},
    })
        .select("channel time")
        .lean();

    const lastReadByChannel = new Map<string, Date>();
    for (const row of reads) {
        lastReadByChannel.set(String(row.channel), row.time);
    }

    const epoch = new Date(0);
    for (let i = 0; i < channelIds.length; i += UNREAD_OR_CHUNK) {
        const chunk = channelIds.slice(i, i + UNREAD_OR_CHUNK);
        const or = chunk.map((channelId) => ({
            channel: channelId,
            createdAt: {$gt: lastReadByChannel.get(String(channelId)) ?? epoch},
        }));

        const grouped = await Message.aggregate<{_id: ObjectId; unread: number}>([
            {
                $match: {
                    $or: or,
                    status: {$in: ["active", "edited"]},
                    deletedFor: {
                        $not: {
                            $elemMatch: {
                                user: userId,
                                showMessage: false,
                            },
                        },
                    },
                },
            },
            {$group: {_id: "$channel", unread: {$sum: 1}}},
        ]);

        for (const row of grouped) {
            if (row.unread > 0) {
                counts.set(String(row._id), row.unread);
            }
        }
    }

    return counts;
}

/**
 * Waiting-queue size plus per-channel unread for staff chats and assigned website chats.
 */
export async function computeInboxBadges(params: {
    companyId: ObjectId;
    memberUserId: ObjectId;
    assignedUserId: ObjectId;
}): Promise<InboxBadgesFormResponseType> {
    const {companyId, memberUserId, assignedUserId} = params;

    const [waitingCount, internalChannels, mineChannels] = await Promise.all([
        Channel.countDocuments({
            company: companyId,
            deleted: false,
            isPublicChat: true,
            "publicChat.status": "requested_human",
            "publicChat.assignedTo": null,
        }),
        Channel.find({
            ...membershipMatch(companyId, memberUserId),
            isPublicChat: {$ne: true},
        })
            .select("_id")
            .lean<Array<{_id: ObjectId}>>(),
        Channel.find({
            company: companyId,
            deleted: false,
            isPublicChat: true,
            "publicChat.assignedTo": assignedUserId,
        })
            .select("_id isPublicChat publicChat.status")
            .lean<ChannelUnreadMeta[]>(),
    ]);

    const internalIds = internalChannels.map((channel) => channel._id);
    const mineIds = mineChannels.map((channel) => channel._id);
    const [internalUnread, mineUnread] = await Promise.all([
        unreadCountsForChannels(internalIds, memberUserId),
        unreadCountsForChannels(mineIds, assignedUserId),
    ]);

    const mineById = new Map(mineChannels.map((channel) => [String(channel._id), channel]));
    const unread: InboxBadgesFormResponseType["unread"] = [];

    for (const [channelId, count] of internalUnread) {
        unread.push({
            channelId,
            unread: count,
            isPublicChat: false,
        });
    }

    for (const [channelId, count] of mineUnread) {
        const channel = mineById.get(channelId);
        unread.push({
            channelId,
            unread: count,
            isPublicChat: true,
            publicChatStatus: channel?.publicChat?.status,
        });
    }

    return {
        waitingCount,
        unread,
    };
}
