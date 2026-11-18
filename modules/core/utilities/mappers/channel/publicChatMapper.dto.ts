/**
 * Wire mapping for public visitor chat.
 *
 * The visitor is anonymous and untrusted, so this is a deliberately narrow
 * projection: message text (mentions shown as names), who said it, when, whether it was edited or deleted, and
 * how many of each reaction it has. No user ids, no receipts, no names of who reacted, no internal channel
 * metadata ever crosses this boundary.
 *
 * @module publicChatMapper.dto
 */

import {ObjectId} from "mongodb";
import {IMessage} from "@coreModule/database/schemas/message/message";
import {IChannel} from "@coreModule/database/schemas/channel/channel";
import {IUser} from "@coreModule/database/schemas/user/user";
import {DecryptStringSafe} from "@coreModule/utilities/security/encryption";
import {splitChatText} from "armonia/src/modules/core/helpers/chatTokens";
import type {
    PublicChatAuthorType,
    PublicChatMessageType,
    PublicChatReactionType,
} from "armonia/src/modules/core/api/user/public/publicChat/publicChat.types";

const idOf = (value: unknown): string => {
    if (!value) return "";
    return ((value as any)?._id ?? value).toString();
};

/**
 * Best-effort display name for an agent, so the widget can say "Ana joined".
 * Falls back to the first name only — the visitor has no business seeing a
 * full employee record.
 */
export function agentDisplayName(user: Partial<IUser> | null | undefined): string | undefined {
    if (!user) return undefined;
    const name = (user.name || "").trim();
    if (name) return name;
    const full = (user.fullName || "").trim();
    return full ? full.split(/\s+/)[0] : undefined;
}

/** Classify a message author from the visitor's point of view. */
export function publicChatAuthor(
    message: IMessage,
    visitorId: ObjectId | string,
    botId: ObjectId | string,
): PublicChatAuthorType {
    const senderId = idOf(message.sender);
    if (senderId === visitorId.toString()) return "visitor";
    if (senderId === botId.toString()) return "bot";
    return "agent";
}

/**
 * The text as the visitor reads it: a mention shows the person's name, never their id (an agent by first name, the
 * visitor by theirs); a shared record, which a website chat never keeps (D162), is dropped.
 */
function visitorText(text: string, mentionedUsers: IMessage["mentionedUsers"]): string {
    const names = new Map((mentionedUsers ?? []).map((user) => [idOf(user), agentDisplayName(user as Partial<IUser>)]));
    return splitChatText(text).map((part) => {
        if (part.kind === "text") return part.text;
        if (part.kind === "record") return "";
        const name = names.get(part.userId);
        return name ? `@${name}` : "@";
    }).join("").replace(/ {2,}/g, " ").trim();
}

/** How many of each emoji a message has, first-used first. */
function reactionCounts(reactions: IMessage["reactions"]): PublicChatReactionType[] {
    const counts = new Map<string, number>();
    for (const reaction of reactions ?? []) {
        const emoji = reaction?.emoji ? DecryptStringSafe(reaction.emoji) : "";
        if (emoji) counts.set(emoji, (counts.get(emoji) ?? 0) + 1);
    }
    return [...counts].map(([emoji, count]) => ({emoji, count}));
}

export function publicChatMessageToDTO(params: {
    message: IMessage;
    visitorId: ObjectId | string;
    botId: ObjectId | string;
}): PublicChatMessageType {
    const {message, visitorId, botId} = params;
    const author = publicChatAuthor(message, visitorId, botId);
    const deleted = message.status === "deleted" || !!message.deletedAt;
    const reactions = deleted ? [] : reactionCounts(message.reactions);

    return {
        _id: message._id.toString(),
        text: deleted ? "" : visitorText(DecryptStringSafe(message.text), message.mentionedUsers),
        author,
        // Only agents get a name; the bot speaks as the company and the visitor
        // already knows who they are.
        ...(author === "agent" ? {authorName: agentDisplayName(message.sender as any)} : {}),
        createdAt: new Date((message as any).createdAt ?? Date.now()).toISOString(),
        ...(deleted ? {deleted: true} : message.status === "edited" ? {edited: true} : {}),
        ...(reactions.length > 0 ? {reactions} : {}),
    };
}

export function publicChatMessagesToDTO(params: { messages: IMessage[]; visitorId: ObjectId | string; botId: ObjectId | string; }): PublicChatMessageType[] {
    const {messages, visitorId, botId} = params;
    return messages
        .map((message) => publicChatMessageToDTO({message, visitorId, botId}))
        // A deleted message stays as a marker; an empty live one (nothing to show) does not.
        .filter((message) => message.deleted || message.text.length > 0);
}

/** The agent currently owning the conversation, if any. */
export function publicChatAgent(channel: IChannel): {hasAgent: boolean; agentName?: string} {
    const assigned = channel.publicChat?.assignedTo as any;
    if (!assigned) {
        return {hasAgent: false};
    }
    return {
        hasAgent: true,
        agentName: agentDisplayName(assigned),
    };
}
