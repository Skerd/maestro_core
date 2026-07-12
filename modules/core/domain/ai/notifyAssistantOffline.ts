/**
 * AI-channel message dispatch, availability-aware.
 *
 * The dedicated `assistantServer` process is the ONLY thing that answers
 * AI-channel messages (see {@link module:aiAssistantResponder}). This module is
 * the single choke point the API server uses to hand a user's AI-channel message
 * off to it — but only when it's actually online:
 *
 *   - responder ONLINE  → publish the Kafka event; the responder answers.
 *   - responder OFFLINE → DISCARD the message (do NOT queue it) and post a bot
 *     notice telling the user the assistant is unavailable right now.
 *
 * Discarding-when-offline is deliberate: a message sent while the assistant is
 * down is dropped, not answered later, so the user is never surprised by a stale
 * answer to a question they've moved on from — they simply retry when it's back.
 *
 * Everything here is best-effort: a failure must never break the user's message
 * send (the human's own message is already saved and delivered by the caller).
 *
 * The offline notice's delivery mirrors {@link module:aiAssistantResponder}
 * (bot-authored, encrypted message, WebSocket NEW_MESSAGE to the user); keep the
 * two in sync.
 *
 * @module notifyAssistantOffline
 */

import {ObjectId} from "mongodb";
import User from "@coreModule/database/schemas/user/user";
import type {serverLogger} from "@coreModule/loggers/serverLog";
import {channelService} from "@coreModule/database/schemas/channel/channel.service";
import {messageService} from "@coreModule/database/schemas/message/message.service";
import {EncryptString} from "@coreModule/utilities/security/encryption";
import {pushWebsocketMessage} from "@coreModule/domain/websocket/pushWebsocketMessage";
import {isAssistantResponderOnline} from "@coreModule/domain/ai/assistantHealth";
import {publishAiChannelMessageEvent} from "@coreModule/kafka/kafkaProducer";
import {WebSocketMessage, WebSocketMessageCodes} from "armonia/src/modules/core/websocket/types";

/**
 * Message shown when the assistant responder process is offline. Because the
 * message is discarded (not queued), this asks the user to retry rather than
 * promising a later reply.
 */
const ASSISTANT_UNAVAILABLE_MESSAGE =
    "The AI assistant is not available at this time. Please try again in a little while.";

export interface AiChannelDispatchParams {
    companyId: string;
    channelId: string;
    /** The human who posted, and who should receive an offline notice. */
    userId: string;
    /** The persisted message id, forwarded to the responder when online. */
    messageId: string;
    /** Plaintext the user typed (pre-encryption), forwarded to the responder. */
    text: string;
    languageCode: string;
    logger: serverLogger;
}

/**
 * Hand an AI-channel message off to the responder when it's online, otherwise
 * discard it and post a "not available" notice. Best-effort and non-blocking —
 * intended to be called fire-and-forget; never throws.
 */
export async function dispatchAiChannelMessage(params: AiChannelDispatchParams): Promise<void> {
    const {companyId, channelId, userId, messageId, text, languageCode, logger} = params;
    try {
        if (await isAssistantResponderOnline()) {
            await publishAiChannelMessageEvent(
                {
                    eventType: "ai_channel_message",
                    companyId,
                    channelId,
                    userId,
                    messageId,
                    text,
                    languageCode,
                    timestamp: Date.now()
                },
                logger
            );
            return;
        }

        // Offline: discard the message (do NOT queue) and tell the user.
        logger.debug(`Assistant responder offline; discarding AI-channel message ${messageId} and notifying user`);
        await postAssistantUnavailableNotice({companyId, channelId, userId, languageCode, logger});
    }
    catch (e: any) {
        // Best-effort — never let dispatch failure surface to the caller.
        logger.warn(`AI-channel dispatch failed for channel ${channelId}: ${e?.message ?? e}`);
    }
}

export interface AssistantUnavailableNoticeParams {
    companyId: string;
    channelId: string;
    /** The human who should receive the notice over WebSocket. */
    userId: string;
    languageCode?: string;
    logger: serverLogger;
}

/**
 * Post a bot-authored "assistant unavailable" notice into the AI channel and
 * deliver it to the user over WebSocket. Unconditional — the caller decides when
 * the assistant is offline. Best-effort: never throws.
 *
 * @returns `true` if a notice was posted, `false` otherwise.
 */
export async function postAssistantUnavailableNotice(params: AssistantUnavailableNoticeParams): Promise<boolean> {
    const {companyId, channelId, userId, languageCode, logger} = params;
    try {
        const companyObjectId = new ObjectId(companyId);
        const channelObjectId = new ObjectId(channelId);

        // The bot user that authors the notice (one per company; same as the responder).
        const bot = await User.findOne({isBot: true, companies: companyObjectId}).select("_id isBot");
        if (!bot) {
            logger.warn(`No bot user for company ${companyId}; cannot post assistant-offline notice`);
            return false;
        }

        const notice = await messageService.create(
            {
                sender: bot,
                channel: channelObjectId,
                text: EncryptString(ASSISTANT_UNAVAILABLE_MESSAGE),
                type: "message",
                status: "active",
                company: companyObjectId
            } as any,
            {logger, languageCode, auditUserId: bot._id.toString()}
        );

        await channelService.updateById(
            channelObjectId,
            {lastAction: new Date()},
            {logger, languageCode, auditUserId: bot._id.toString()}
        );

        // Deliver to the human over WebSocket, same path as a normal reply.
        const websocketMessage: WebSocketMessage<{channelId: string; messageId: string}> = {
            code: WebSocketMessageCodes.NEW_MESSAGE,
            payload: {channelId, messageId: notice._id.toString()},
            userIds: [userId]
        };
        pushWebsocketMessage(websocketMessage);

        logger.debug(`Posted assistant-offline notice in AI channel ${channelId} for user ${userId}`);
        return true;
    }
    catch (e: any) {
        // Best-effort — never let the notice failure surface to the caller.
        logger.warn(`Failed to post assistant-offline notice in channel ${channelId}: ${e?.message ?? e}`);
        return false;
    }
}
