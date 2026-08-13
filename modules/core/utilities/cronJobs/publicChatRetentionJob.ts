/**
 * Public chat retention sweep.
 *
 * A public widget on the open internet accumulates junk: bots, scrapers, and
 * people who opened the orb, typed nothing, and left. Each of those costs a
 * `User` document, a `Channel`, and whatever was said. This job removes the ones
 * that turned out to be worthless, and ONLY those.
 *
 * A conversation is deleted when ALL of the following hold:
 *   - it is a public chat, idle for longer than the retention window;
 *   - no human agent was ever assigned to it; and
 *   - it produced no CRM lead.
 *
 * In other words: anything a person touched, or that became commercially real,
 * is kept and ages out under normal record-keeping rules instead. This is
 * deliberately conservative — deleting a real customer conversation to save a
 * few kilobytes would be a far worse outcome than keeping too much.
 *
 * @module publicChatRetentionJob
 */

import {ObjectId} from "mongodb";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import Channel from "@coreModule/database/schemas/channel/channel";
import Message from "@coreModule/database/schemas/message/message";
import User from "@coreModule/database/schemas/user/user";
import {PUBLIC_CHAT} from "@coreModule/environment";

/** Batch size per sweep, so one run cannot lock the database for long. */
const MAX_DELETIONS_PER_RUN = 500;

export interface PublicChatRetentionResult {
    examined: number;
    deletedChannels: number;
    deletedMessages: number;
    deletedVisitors: number;
}

/**
 * Delete abandoned, never-escalated, lead-free public chats older than the
 * retention window.
 */
export async function runPublicChatRetention(
    parentLogger?: serverLogger,
    retentionDaysOverride?: number,
): Promise<PublicChatRetentionResult> {
    const logger = getLogger("public_chat_retention", parentLogger);
    const retentionDays = retentionDaysOverride ?? PUBLIC_CHAT.RETENTION_DAYS;
    logger.start(`Sweeping public chats idle for more than ${retentionDays} day(s)...`);

    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    const candidates = await Channel.find({
        isPublicChat: true,
        "publicChat.lastVisitorActivity": {$lt: cutoff},
        // Never touched by a person...
        $and: [
            {$or: [{"publicChat.assignedTo": null}, {"publicChat.assignedTo": {$exists: false}}]},
            // ...and never turned into a lead.
            {$or: [{"publicChat.lead": null}, {"publicChat.lead": {$exists: false}}]},
            // A chat that was escalated had a person waiting on it, even if
            // nobody managed to join. Keep those: they are a service failure
            // worth being able to review.
            {"publicChat.status": {$ne: "requested_human"}},
        ],
    })
        .select("_id aiOwnerUser")
        .limit(MAX_DELETIONS_PER_RUN);

    if (candidates.length === 0) {
        logger.finish("No public chats to sweep");
        return {examined: 0, deletedChannels: 0, deletedMessages: 0, deletedVisitors: 0};
    }

    const channelIds = candidates.map((channel) => channel._id);
    const visitorIds = candidates
        .map((channel) => ((channel.aiOwnerUser as any)?._id ?? channel.aiOwnerUser))
        .filter(Boolean)
        .map((id: any) => new ObjectId(id.toString()));

    // Messages first: an orphaned message is harder to find later than an
    // orphaned channel, so delete inward-out.
    const messageResult = await Message.deleteMany({channel: {$in: channelIds}});
    const channelResult = await Channel.deleteMany({_id: {$in: channelIds}});

    // Only ever delete users that are actually visitors — a guard against a
    // malformed `aiOwnerUser` pointing at a real person.
    const visitorResult = visitorIds.length > 0
        ? await User.deleteMany({_id: {$in: visitorIds}, isVisitor: true})
        : {deletedCount: 0};

    const result: PublicChatRetentionResult = {
        examined: candidates.length,
        deletedChannels: channelResult.deletedCount ?? 0,
        deletedMessages: messageResult.deletedCount ?? 0,
        deletedVisitors: visitorResult.deletedCount ?? 0,
    };

    logger.finish(
        `Swept ${result.deletedChannels} public chat(s): ` +
        `${result.deletedMessages} message(s), ${result.deletedVisitors} visitor(s)`,
    );
    return result;
}
