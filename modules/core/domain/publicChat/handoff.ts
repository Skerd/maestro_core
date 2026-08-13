/**
 * Public chat handoff — moving a conversation between the bot and a human.
 *
 * The state machine lives here so the three entry points (the visitor pressing
 * "talk to a person", the bot escalating itself via `request_human_agent`, and
 * an agent taking over from the panel) all go through one implementation.
 *
 *     bot ──escalate──► requested_human ──agent joins──► human
 *      ▲                                                  │
 *      └──────────────── agent releases ──────────────────┘
 *
 * Only `bot` is bot-served. The moment a conversation escalates, the assistant
 * stops answering — see `isBotServing` in the send endpoint.
 *
 * @module publicChat/handoff
 */

import {ObjectId} from "mongodb";
import {UpdateQuery} from "mongoose";
import type {serverLogger} from "@coreModule/loggers/serverLog";
import Channel, {IChannel} from "@coreModule/database/schemas/channel/channel";
import {channelService} from "@coreModule/database/schemas/channel/channel.service";
import {messageService} from "@coreModule/database/schemas/message/message.service";
import {setPublicChatStatus} from "@coreModule/database/schemas/channel/channel.helper";
import Company from "@coreModule/database/schemas/company/company";
import {EncryptString} from "@coreModule/utilities/security/encryption";
import {pushWebsocketMessage} from "@coreModule/domain/websocket/pushWebsocketMessage";
import {emitNotificationEvent, NotificationEventCodes} from "@coreModule/domain/notifications/notificationEventBus";
import {normalizeSchemaPermissions} from "@coreModule/database/utilities";
import RolePermission from "@coreModule/database/schemas/rolePermission/rolePermission";
import Role from "@coreModule/database/schemas/role/role";
import User from "@coreModule/database/schemas/user/user";
import {WebSocketMessage, WebSocketMessageCodes} from "armonia/src/modules/core/websocket/types";

/** What the visitor is told when the conversation is escalated. */
const HANDOFF_ACKNOWLEDGEMENT =
    "Let me connect you with someone from our team. Please hold on a moment — " +
    "you can keep typing and they will see everything you have written.";

/**
 * Post a bot-authored system line into a public chat and deliver it to the
 * visitor. Best-effort: a failure here must never fail the state transition.
 */
async function postBotNotice(params: {
    channel: IChannel;
    text: string;
    visitorId: ObjectId;
    languageCode?: string;
    logger?: serverLogger;
}): Promise<void> {
    const {channel, text, visitorId, languageCode, logger} = params;
    try {
        const companyId = (channel.company as any)?._id ?? channel.company;
        const botId = await Company.findRobotId(new ObjectId(companyId.toString()));
        if (!botId) {
            return;
        }

        const notice = await messageService.create(
            {
                sender: botId,
                channel: channel._id,
                text: EncryptString(text),
                type: "message",
                status: "active",
                company: companyId,
            } as any,
            {logger, languageCode, auditUserId: botId.toString()},
        );

        await channelService.updateById(
            channel._id,
            {lastAction: new Date()},
            {logger, languageCode, auditUserId: botId.toString()},
        );

        const websocketMessage: WebSocketMessage<{channelId: string; messageId: string}> = {
            code: WebSocketMessageCodes.NEW_MESSAGE,
            payload: {channelId: channel._id.toString(), messageId: notice._id.toString()},
            userIds: [visitorId.toString()],
        };
        pushWebsocketMessage(websocketMessage);
    }
    catch (e: any) {
        logger?.warn(`Failed to post public-chat notice: ${e?.message ?? e}`);
    }
}

/**
 * Users who may answer public chats in a company.
 *
 * Permission tags in this codebase are DERIVED from schema field permissions
 * (see `rolePermission.default.ts`) rather than declared as free-form strings,
 * so rather than invent a tag we reuse the one that already means "may change
 * who is in a channel" — `channels[write:users]` — and read it off the schema at
 * runtime so a change in tag format cannot silently break this lookup.
 *
 * Company admins are always included.
 */
export async function resolvePublicChatAgentIds(
    companyId: ObjectId,
    logger?: serverLogger,
): Promise<string[]> {
    try {
        const normalized = normalizeSchemaPermissions(Channel);
        const tag = (normalized.permissions as any)?.users?.self?.write;

        const roleFilter: Record<string, unknown>[] = [{company: companyId, isAdmin: true}];
        if (tag && tag !== "no-permission") {
            const permission = await RolePermission.findOne({tag}).select("_id");
            if (permission) {
                roleFilter.push({company: companyId, permissions: permission._id});
            }
        }

        const roles = await Role.find({$or: roleFilter}).select("_id");
        if (roles.length === 0) {
            return [];
        }
        const roleIds = roles.map((role) => role._id);

        const agents = await User.find({
            companies: companyId,
            isBot: {$ne: true},
            isVisitor: {$ne: true},
            deletedAt: null,
            roles: {
                $elemMatch: {
                    company: companyId,
                    active: "active",
                    roles: {$in: roleIds},
                },
            },
        }).select("_id");

        return agents.map((agent) => agent._id.toString());
    }
    catch (e: any) {
        logger?.warn(`Failed to resolve public-chat agents for company ${companyId.toString()}: ${e?.message ?? e}`);
        return [];
    }
}

export interface RequestHandoffParams {
    channel: IChannel;
    companyId: ObjectId;
    visitorId: ObjectId;
    /** Free text explaining why, when the bot escalated itself. */
    reason?: string;
    languageCode?: string;
    logger?: serverLogger;
}

/**
 * Escalate a conversation from the bot to a human.
 *
 * Idempotent: escalating an already-escalated or human-owned chat is a no-op, so
 * a visitor mashing the button (or the model calling the tool twice) does not
 * spam agents.
 *
 * @returns true when this call performed the escalation.
 */
export async function requestHumanHandoff(params: RequestHandoffParams): Promise<boolean> {
    const {channel, companyId, visitorId, reason, languageCode, logger} = params;

    const status = channel.publicChat?.status ?? "bot";
    if (status !== "bot") {
        logger?.debug(`Public chat ${channel._id.toString()} already in status ${status}; not re-escalating`);
        return false;
    }

    await setPublicChatStatus({
        channelId: channel._id,
        status: "requested_human",
        languageCode,
        logger,
        auditUserId: visitorId.toString(),
    });

    await postBotNotice({
        channel,
        text: HANDOFF_ACKNOWLEDGEMENT,
        visitorId,
        languageCode,
        logger,
    });

    const agentIds = await resolvePublicChatAgentIds(companyId, logger);
    if (agentIds.length > 0) {
        emitNotificationEvent(NotificationEventCodes.PUBLIC_CHAT_HANDOFF_REQUESTED, {
            receiverIds: agentIds,
            payload: {
                companyId: companyId.toString(),
                channelId: channel._id.toString(),
                visitorName: channel.publicChat?.visitor?.displayName ?? "A website visitor",
                entryUrl: channel.publicChat?.visitor?.entryUrl ?? null,
                reason: reason ?? null,
                languageCode,
            },
        });
    }
    else {
        logger?.warn(`No agents available to notify for public chat ${channel._id.toString()}`);
    }

    logger?.debug(`Public chat ${channel._id.toString()} escalated to a human`);
    return true;
}

/**
 * An agent takes the conversation over: joins the channel, is recorded as the
 * assignee, and the visitor is told who they are now talking to.
 */
export async function assignAgentToPublicChat(params: {
    channel: IChannel;
    agentId: ObjectId;
    agentDisplayName?: string;
    visitorId: ObjectId;
    languageCode?: string;
    logger?: serverLogger;
}): Promise<void> {
    const {channel, agentId, agentDisplayName, visitorId, languageCode, logger} = params;

    await channelService.updateById(
        channel._id,
        {
            $addToSet: {users: agentId},
            $set: {
                "publicChat.status": "human",
                "publicChat.assignedTo": agentId,
            },
        } as unknown as UpdateQuery<IChannel>,
        {logger, languageCode, auditUserId: agentId.toString()},
    );

    await postBotNotice({
        channel,
        text: agentDisplayName
            ? `${agentDisplayName} has joined the conversation.`
            : "Someone from our team has joined the conversation.",
        visitorId,
        languageCode,
        logger,
    });

    logger?.debug(`Agent ${agentId.toString()} took over public chat ${channel._id.toString()}`);
}

/**
 * Hand the conversation back to the bot. The agent is removed from
 * `channel.users` so the thread leaves their inbox; visitor + bot stay.
 */
export async function releasePublicChatToBot(params: {
    channel: IChannel;
    agentId: ObjectId;
    visitorId: ObjectId;
    languageCode?: string;
    logger?: serverLogger;
}): Promise<void> {
    const {channel, agentId, visitorId, languageCode, logger} = params;

    await setPublicChatStatus({
        channelId: channel._id,
        status: "bot",
        languageCode,
        logger,
        auditUserId: agentId.toString(),
    });

    await channelService.updateById(
        channel._id,
        {$pull: {users: agentId}} as unknown as UpdateQuery<IChannel>,
        {logger, languageCode, auditUserId: agentId.toString()},
    );

    const websocketMessage: WebSocketMessage<{channelId: string}> = {
        code: WebSocketMessageCodes.CHANNEL_DELETED,
        payload: {channelId: channel._id.toString()},
        userIds: [agentId.toString()],
    };
    pushWebsocketMessage(websocketMessage);

    await postBotNotice({
        channel,
        text: "You are back with our virtual assistant. How else can I help?",
        visitorId,
        languageCode,
        logger,
    });

    logger?.debug(`Public chat ${channel._id.toString()} released back to the bot`);
}
