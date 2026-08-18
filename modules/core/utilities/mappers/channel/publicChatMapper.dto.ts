/**
 * Wire mapping for public visitor chat.
 *
 * The visitor is anonymous and untrusted, so this is a deliberately narrow
 * projection: message text, who said it, and when. No user ids, no receipts, no
 * reactions, no internal channel metadata ever crosses this boundary.
 *
 * @module publicChatMapper.dto
 */

import {ObjectId} from "mongodb";
import {IMessage} from "@coreModule/database/schemas/message/message";
import {IChannel} from "@coreModule/database/schemas/channel/channel";
import {IUser} from "@coreModule/database/schemas/user/user";
import {DecryptStringSafe} from "@coreModule/utilities/security/encryption";
import type {
    PublicChatAuthorType,
    PublicChatMessageType,
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

export function publicChatMessageToDTO(params: {
    message: IMessage;
    visitorId: ObjectId | string;
    botId: ObjectId | string;
}): PublicChatMessageType {
    const {message, visitorId, botId} = params;
    const author = publicChatAuthor(message, visitorId, botId);

    return {
        _id: message._id.toString(),
        text: DecryptStringSafe(message.text),
        author,
        // Only agents get a name; the bot speaks as the company and the visitor
        // already knows who they are.
        ...(author === "agent" ? {authorName: agentDisplayName(message.sender as any)} : {}),
        createdAt: new Date((message as any).createdAt ?? Date.now()).toISOString(),
    };
}

export function publicChatMessagesToDTO(params: { messages: IMessage[]; visitorId: ObjectId | string; botId: ObjectId | string; }): PublicChatMessageType[] {
    const {messages, visitorId, botId} = params;
    return messages
        .filter((message) => !(message as any).deletedAt && message.status !== "deleted")
        .map((message) => publicChatMessageToDTO({message, visitorId, botId}))
        .filter((message) => message.text.length > 0);
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
