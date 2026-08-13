/**
 * Public visitor chat API.
 *
 * The only chat surface reachable without an account. An anonymous website
 * visitor opens a session, talks to the tenant's AI bot, and — once the handoff
 * work lands — can be joined by a human agent.
 *
 * SECURITY POSTURE (this is internet-facing; the private chat API is not):
 *   - Tenant comes from the request origin, never from the client payload.
 *   - Identity comes from a visitor token scoped to ONE channel; every request
 *     re-verifies the visitor/channel/company chain (see `visitorAuthMW`).
 *   - This is a deliberately trimmed re-implementation of the private message
 *     endpoints — no mentions, no forwarding, no replies, no media, no reactions.
 *     Keep it that way; each of those is an attack surface the visitor does not
 *     need.
 *   - The bot answers with the `public` tool audience only, so CRM tools
 *     (leads/reservations/leases) are not even offered to the model.
 *
 * @module f_endpoints/core/user/public/publicChat
 */

import {Router} from "express";
import {ObjectId} from "mongodb";
import authMW, {NotAuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import visitorAuthMW, {VisitorAuthenticatedMWType} from "@coreModule/utilities/middlewares/visitorAuthMW";
import {asyncHandler} from "@coreModule/utilities/middlewares/asyncHandler";
import {rateLimiter} from "@coreModule/utilities/middlewares/rateLimiter";
import {validateFormZod} from "@coreModule/utilities/middlewares/validateFormZod";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {resolveCompanyByOrigin} from "@coreModule/utilities/marketing/resolveCompanyByOrigin";
import {resolveVisitorContext} from "@coreModule/utilities/middlewares/visitorAuthMW";
import {generateVisitorToken} from "@coreModule/utilities/security/visitorToken";
import {channelService} from "@coreModule/database/schemas/channel/channel.service";
import {messageService} from "@coreModule/database/schemas/message/message.service";
import {IChannel} from "@coreModule/database/schemas/channel/channel";
import {IUser} from "@coreModule/database/schemas/user/user";
import {ICompany} from "@coreModule/database/schemas/company/company";
import {
    createPublicChat, erasePublicChat,
    isBotServing,
    setPublicChatStatus,
    touchPublicChat,
} from "@coreModule/database/schemas/channel/channel.helper";
import {PUBLIC_CHAT} from "@coreModule/environment";
import {EncryptString} from "@coreModule/utilities/security/encryption";
import {dispatchAiChannelMessage} from "@coreModule/domain/ai/notifyAssistantOffline";
import {isAssistantResponderOnline} from "@coreModule/domain/ai/assistantHealth";
import {pushWebsocketMessage} from "@coreModule/domain/websocket/pushWebsocketMessage";
import {WebSocketMessage, WebSocketMessageCodes} from "armonia/src/modules/core/websocket/types";
import {
    publicChatAgent,
    publicChatMessagesToDTO,
    publicChatMessageToDTO,
} from "@coreModule/utilities/mappers/channel/publicChatMapper.dto";
import {
    startPublicChatSessionFormSchema,
    StartPublicChatSessionFormType,
} from "armonia/src/modules/core/api/user/public/publicChat/startPublicChatSession/startPublicChatSession.form.validator";
import {
    StartPublicChatSessionFormResponseType,
} from "armonia/src/modules/core/api/user/public/publicChat/startPublicChatSession/startPublicChatSession.form.response.type";
import {
    publicChatMessagesFormSchema,
    PublicChatMessagesFormType,
} from "armonia/src/modules/core/api/user/public/publicChat/publicChatMessages/publicChatMessages.form.validator";
import {
    PublicChatMessagesFormResponseType,
} from "armonia/src/modules/core/api/user/public/publicChat/publicChatMessages/publicChatMessages.form.response.type";
import {
    sendPublicChatMessageFormSchema,
    SendPublicChatMessageFormType,
} from "armonia/src/modules/core/api/user/public/publicChat/sendPublicChatMessage/sendPublicChatMessage.form.validator";
import {
    SendPublicChatMessageFormResponseType,
} from "armonia/src/modules/core/api/user/public/publicChat/sendPublicChatMessage/sendPublicChatMessage.form.response.type";
import {
    requestPublicChatHandoffFormSchema,
    RequestPublicChatHandoffFormType,
} from "armonia/src/modules/core/api/user/public/publicChat/requestPublicChatHandoff/requestPublicChatHandoff.form.validator";
import {
    RequestPublicChatHandoffFormResponseType,
} from "armonia/src/modules/core/api/user/public/publicChat/requestPublicChatHandoff/requestPublicChatHandoff.form.response.type";
import {requestHumanHandoff} from "@coreModule/domain/publicChat/handoff";
import {consumeVisitorMessageQuota} from "@coreModule/domain/publicChat/publicChatQuota";
import type {ActionMessage} from "armonia/src/modules/core/types/shared.types";
import type {PublicChatStatusType} from "armonia/src/modules/core/api/user/public/publicChat/publicChat.types";

const router = Router();

/** How many messages the widget loads when it opens a conversation. */
const HISTORY_LIMIT = 50;

// -------------------------------------------------------------------------
// Routes
// -------------------------------------------------------------------------

/**
 * POST /api/public/chat/session — start a new conversation or resume an existing one.
 *
 * The only route that accepts an *optional* visitor token: with one it resumes,
 * without one it mints a new visitor identity.
 */
router.post(
    "/session",
    authMW("public"),
    rateLimiter({windowMs: 60000, max: 10}),
    validateFormZod(startPublicChatSessionFormSchema),
    asyncHandler(startPublicChatSession),
);

/** POST /api/public/chat/messages — conversation history / polling. */
router.post(
    "/messages",
    authMW("public"),
    rateLimiter({windowMs: 60000, max: 120}),
    visitorAuthMW(),
    validateFormZod(publicChatMessagesFormSchema),
    asyncHandler(listPublicChatMessages),
);

/** PUT /api/public/chat/messages — the visitor says something. */
router.put(
    "/messages",
    authMW("public"),
    rateLimiter({windowMs: 60000, max: 20}),
    visitorAuthMW(),
    validateFormZod(sendPublicChatMessageFormSchema),
    asyncHandler(sendPublicChatMessage),
);

/** POST /api/public/chat/handoff — visitor asks to speak to a person. */
router.post(
    "/handoff",
    authMW("public"),
    rateLimiter({windowMs: 60000, max: 5}),
    visitorAuthMW(),
    validateFormZod(requestPublicChatHandoffFormSchema),
    asyncHandler(requestPublicChatHandoff),
);

/** POST /api/public/chat/close — visitor ends the conversation. */
router.post(
    "/close",
    authMW("public"),
    rateLimiter({windowMs: 60000, max: 10}),
    visitorAuthMW(),
    asyncHandler(closePublicChat),
);

/**
 * DELETE /api/public/chat — erase this conversation entirely.
 *
 * The visitor's right-to-erasure path: unlike `/close` (which keeps the
 * transcript so an agent can review it), this destroys the messages, the channel
 * and the visitor identity. Deliberately available without any account, because
 * the person exercising the right does not have one.
 */
router.delete(
    "",
    authMW("public"),
    rateLimiter({windowMs: 60000, max: 5}),
    visitorAuthMW(),
    asyncHandler(deletePublicChatData),
);

// -------------------------------------------------------------------------
// Handlers
// -------------------------------------------------------------------------

type StartSessionParams = NotAuthenticatedMWType & StartPublicChatSessionFormType;

async function startPublicChatSession(
    params: StartSessionParams,
): Promise<StartPublicChatSessionFormResponseType> {
    const {origin, languageCode, logger, requestIp, userAgent, visitorToken, entryUrl, referrer, projectId, unitId} = params;
    logger.start("Opening public chat session...");

    const company = await resolveCompanyByOrigin(origin, languageCode);
    assertPublicChatEnabled(company, languageCode);

    let channel: IChannel | null = null;
    let visitor: IUser | null = null;

    // Resume, when the browser presented a token that still checks out. A stale
    // or foreign token is not an error the visitor can act on — fall through and
    // give them a fresh conversation instead.
    if (visitorToken) {
        try {
            const resumed = await resolveVisitorContext({
                token: visitorToken,
                languageCode,
                originCompanyId: company._id,
            });
            channel = resumed.visitorChannel;
            visitor = resumed.visitorUser;
            logger.debug(`Resumed public chat ${channel._id.toString()}`);
        }
        catch {
            logger.debug("Presented visitor token was not resumable; starting a new conversation");
        }
    }

    if (!channel || !visitor) {
        const created = await createPublicChat({
            companyId: company._id,
            languageCode,
            logger,
            visitor: {ip: requestIp, userAgent, entryUrl, referrer},
            context: {
                ...(projectId ? {project: new ObjectId(projectId)} : {}),
                ...(unitId ? {unit: new ObjectId(unitId)} : {}),
            },
        });
        channel = created.channel;
        visitor = created.visitor;
    }

    const botId = await requireBotId(company, languageCode, logger);
    const messages = await loadMessages({
        channel,
        visitorId: visitor._id,
        botId,
        languageCode,
        logger,
        limit: HISTORY_LIMIT,
    });

    const token = generateVisitorToken({
        visitorId: visitor._id,
        companyId: company._id,
        channelId: channel._id,
        languageCode,
    });

    const agent = publicChatAgent(channel);
    logger.finish(`Public chat session ready (${channel._id.toString()}, ${messages.length} message(s))`);

    return {
        token,
        channelId: channel._id.toString(),
        status: (channel.publicChat?.status ?? "bot") as PublicChatStatusType,
        ...agent,
        // Only offer the scripted opener on an empty conversation.
        ...(messages.length === 0 && company.publicAiChat?.greeting
            ? {greeting: company.publicAiChat.greeting}
            : {}),
        humanHandoffEnabled: company.publicAiChat?.humanHandoffEnabled !== false,
        requireIdentification: company.publicAiChat?.requireIdentification === true,
        assistantOnline: await isAssistantResponderOnline(),
        messages,
    };
}

type ListMessagesParams = VisitorAuthenticatedMWType & PublicChatMessagesFormType;

async function listPublicChatMessages(
    params: ListMessagesParams,
): Promise<PublicChatMessagesFormResponseType> {
    const {languageCode, logger, visitorUser, visitorChannel, visitorCompany, since, limit} = params;
    logger.start(`Loading public chat messages for ${visitorChannel._id.toString()}...`);

    const botId = await requireBotId(visitorCompany, languageCode, logger);

    // Re-read the channel so polling picks up an agent joining or the status moving.
    const channel = (await channelService.findOne(
        {_id: visitorChannel._id, isPublicChat: true},
        {logger, languageCode},
        ["publicChat.assignedTo"],
    )) ?? visitorChannel;

    const messages = await loadMessages({
        channel,
        visitorId: visitorUser._id,
        botId,
        languageCode,
        logger,
        limit: limit ?? HISTORY_LIMIT,
        since: since ? new Date(since) : undefined,
    });

    logger.finish(`Loaded ${messages.length} public chat message(s)`);
    return {
        messages,
        status: (channel.publicChat?.status ?? "bot") as PublicChatStatusType,
        ...publicChatAgent(channel),
    };
}

type SendMessageParams = VisitorAuthenticatedMWType & SendPublicChatMessageFormType;

async function sendPublicChatMessage(
    params: SendMessageParams,
): Promise<SendPublicChatMessageFormResponseType> {
    const {languageCode, logger, visitorUser, visitorChannel, visitorCompany, text} = params;
    logger.start(`Visitor message in public chat ${visitorChannel._id.toString()}...`);

    assertPublicChatEnabled(visitorCompany, languageCode);

    // Per-visitor and per-tenant budgets, charged before anything is persisted
    // or sent to the model. The endpoint rate limiter above keys on IP and so
    // cannot see a single visitor grinding away all day, nor a distributed flood
    // aimed at one tenant.
    const quota = await consumeVisitorMessageQuota({
        visitorId: visitorUser._id.toString(),
        companyId: visitorCompany._id.toString(),
        logger,
    });
    if (!quota.allowed) {
        logger.debug(`Public chat quota exhausted (${quota.scope}) for visitor ${visitorUser._id.toString()}`);
        throw apiValidationException(
            quota.scope === "company_day" ? "public_chat_busy" : "public_chat_rate_limited",
            "text",
            null,
            languageCode,
        );
    }

    // Bound the conversation. Past the cap the visitor starts a new chat rather
    // than growing one thread (and its LLM context) without limit.
    const messageCount = await messageService.count(
        {channel: visitorChannel._id, type: "message"},
        {logger, languageCode},
    );
    if (messageCount >= PUBLIC_CHAT.MAX_MESSAGES) {
        throw apiValidationException("public_chat_message_limit_reached", "text", null, languageCode);
    }

    const botId = await requireBotId(visitorCompany, languageCode, logger);
    const trimmed = text.trim();

    const created = await messageService.create(
        {
            sender: visitorUser._id,
            channel: visitorChannel._id,
            text: EncryptString(trimmed),
            type: "message",
            status: "active",
            company: visitorCompany._id,
        } as any,
        {logger, languageCode, auditUserId: visitorUser._id.toString()},
    );

    await touchPublicChat({
        channelId: visitorChannel._id,
        languageCode,
        logger,
        auditUserId: visitorUser._id.toString(),
    });

    // Deliver to anyone else in the channel (an agent who has taken over). The
    // visitor is excluded — they already have the message optimistically — and
    // so is the bot, which has no client.
    const otherUserIds = (visitorChannel.users || [])
        .map((user: any) => (user?._id ?? user).toString())
        .filter((id: string) => id !== visitorUser._id.toString() && id !== botId.toString());
    if (otherUserIds.length > 0) {
        const websocketMessage: WebSocketMessage<{channelId: string; messageId: string}> = {
            code: WebSocketMessageCodes.NEW_MESSAGE,
            payload: {
                channelId: visitorChannel._id.toString(),
                messageId: created._id.toString(),
            },
            userIds: otherUserIds,
        };
        pushWebsocketMessage(websocketMessage);
    }

    // Hand to the assistant ONLY while the bot owns the conversation. Once a
    // human has taken over, the bot stays quiet.
    const botServing = isBotServing(visitorChannel);
    let awaitingBotReply = false;
    if (botServing) {
        awaitingBotReply = await isAssistantResponderOnline();
        void dispatchAiChannelMessage({
            companyId: visitorCompany._id.toString(),
            channelId: visitorChannel._id.toString(),
            userId: visitorUser._id.toString(),
            messageId: created._id.toString(),
            text: trimmed,
            languageCode,
            logger,
        });
    }

    logger.finish(`Public chat message stored (${created._id.toString()}), bot serving: ${botServing}`);
    return {
        message: publicChatMessageToDTO({
            message: created,
            visitorId: visitorUser._id,
            botId,
        }),
        status: (visitorChannel.publicChat?.status ?? "bot") as PublicChatStatusType,
        awaitingBotReply,
    };
}

type HandoffParams = VisitorAuthenticatedMWType & RequestPublicChatHandoffFormType;

async function requestPublicChatHandoff(
    params: HandoffParams,
): Promise<RequestPublicChatHandoffFormResponseType> {
    const {languageCode, logger, visitorUser, visitorChannel, visitorCompany, note} = params;
    logger.start(`Handoff requested for public chat ${visitorChannel._id.toString()}...`);

    if (visitorCompany.publicAiChat?.humanHandoffEnabled === false) {
        throw apiValidationException("public_chat_handoff_not_enabled", "company", null, languageCode);
    }

    const requested = await requestHumanHandoff({
        channel: visitorChannel,
        companyId: visitorCompany._id,
        visitorId: visitorUser._id,
        reason: note,
        languageCode,
        logger,
    });

    logger.finish(`Handoff ${requested ? "registered" : "was already pending"}`);
    return {
        requested,
        // Escalation always leaves the chat in a human-owned state; if it was
        // already escalated, report whatever it is actually in now.
        status: requested
            ? "requested_human"
            : ((visitorChannel.publicChat?.status ?? "requested_human") as PublicChatStatusType),
    };
}

type CloseChatParams = VisitorAuthenticatedMWType;

async function closePublicChat(params: CloseChatParams): Promise<ActionMessage> {
    const {languageCode, logger, visitorUser, visitorChannel} = params;
    logger.start(`Closing public chat ${visitorChannel._id.toString()}...`);

    await setPublicChatStatus({
        channelId: visitorChannel._id,
        status: "closed",
        languageCode,
        logger,
        auditUserId: visitorUser._id.toString(),
    });

    logger.finish("Public chat closed");
    return {message: "Public chat closed"};
}

async function deletePublicChatData(params: CloseChatParams): Promise<ActionMessage> {
    const {languageCode, logger, visitorUser, visitorChannel} = params;
    logger.start(`Erasing public chat ${visitorChannel._id.toString()} at visitor request...`);

    await erasePublicChat({
        channelId: visitorChannel._id,
        visitorId: visitorUser._id,
        languageCode,
        logger,
    });

    logger.finish("Public chat erased");
    return {message: "Public chat erased"};
}

// -------------------------------------------------------------------------
// Shared helpers
// -------------------------------------------------------------------------

/** The tenant must have switched the widget on. */
function assertPublicChatEnabled(company: ICompany, languageCode: string): void {
    if (company.publicAiChat?.enabled !== true) {
        throw apiValidationException("public_chat_not_enabled", "company", null, languageCode);
    }
}

/** The company bot authors every AI reply; without one there is no conversation. */
async function requireBotId(
    company: ICompany,
    languageCode: string,
    logger: NotAuthenticatedMWType["logger"],
): Promise<ObjectId> {
    const botId = await company.getRobotId();
    if (!botId) {
        logger.err(`Company ${company._id.toString()} has no bot user`);
        throw apiValidationException("ai_channel_unavailable", "company", null, languageCode);
    }
    return botId;
}

/** Load conversation messages oldest-first, mapped to the public projection. */
async function loadMessages(params: {
    channel: IChannel;
    visitorId: ObjectId;
    botId: ObjectId;
    languageCode: string;
    logger: NotAuthenticatedMWType["logger"];
    limit: number;
    since?: Date;
}) {
    const {channel, visitorId, botId, languageCode, logger, limit, since} = params;

    const found = await messageService.find(
        {
            channel: channel._id,
            type: "message",
            status: {$ne: "deleted"},
            ...(since ? {createdAt: {$gt: since}} : {}),
        },
        {logger, languageCode},
        ["sender"],
        "sender text status deletedAt type createdAt",
        {createdAt: since ? 1 : -1},
        limit,
    );

    // Without a `since` cursor we fetched newest-first to get the tail of a long
    // conversation; the widget always renders oldest-first.
    const ordered = since ? found : [...found].reverse();
    return publicChatMessagesToDTO({messages: ordered as any, visitorId, botId});
}

export const basePath = "/api/public/chat";
module.exports = {router, basePath};
