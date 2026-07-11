/**
 * AI-Assistant Channel Responder ("Layer 2", in-app)
 *
 * The in-app internal chat is the ONLY transport for the AI-assistant. When a
 * human user posts in their dedicated AI-assistant channel, this composes the
 * assistant's reply and delivers it back over WebSocket. Telegram is
 * deliberately decoupled and does NOT route messages here (Telegram is a
 * notifications-only transport; see connectToTelegram.ts).
 *
 * The reply itself comes from {@link generateAssistantReply} — an empty shell
 * with no commands or protocols, waiting for a real LLM. This responder only
 * orchestrates persistence, WebSocket delivery, and receipts; it has no answer
 * logic of its own.
 *
 * Invoked by the AI-channel Kafka consumer (see `aiChannelConsumer`). Any thrown
 * error is contained by the consumer's retry machinery.
 *
 * @module aiAssistantResponder
 */

import User from "@coreModule/database/schemas/user/user";
import {getLogger} from "@coreModule/loggers/serverLog";
import {channelService} from "@coreModule/database/schemas/channel/channel.service";
import {messageService} from "@coreModule/database/schemas/message/message.service";
import {EncryptString} from "@coreModule/utilities/security/encryption";
import {pushWebsocketMessage} from "@coreModule/domain/websocket/pushWebsocketMessage";
import {applyMessageReceipts} from "@coreModule/domain/messages/applyMessageReceipts";
import {generateAssistantReply} from "@coreModule/domain/ai/assistantBrain";
import {recordAssistantResult} from "@coreModule/domain/ai/assistantHealth";
import {AiChannelMessageEvent} from "@coreModule/kafka/types";
import {WebSocketMessage, WebSocketMessageCodes} from "armonia/src/modules/core/websocket/types";
import {ObjectId} from "mongodb";

/**
 * Compose and deliver the bot's reply to a message in an AI-assistant channel.
 *
 * @param event - The AI-channel message event published when the user posted.
 */
export async function respondToAiChannelMessage(event: AiChannelMessageEvent): Promise<void> {
    const logger = getLogger("ai_assistant_responder");
    logger.start(`Responding in AI channel ${event.channelId} for user ${event.userId}`);

    const startedAt = Date.now();
    try {
        const delivered = await composeAndDeliverAiReply(event, logger);
        // Only delivered replies count as "answered"; skips (channel/user
        // missing) are neither answered nor failed.
        if (delivered) {
            recordAssistantResult("answered", Date.now() - startedAt);
        }
    }
    catch (err) {
        // Count the failure for the performance UI, then rethrow so the
        // consumer's retry/DLQ machinery still handles it.
        recordAssistantResult("failed", Date.now() - startedAt);
        throw err;
    }
}

/**
 * The actual compose-and-deliver work. Returns `false` (a skip — counted as
 * neither answered nor failed) when the message can't be answered: the channel
 * is no longer an AI channel, or the bot/human user is missing. Returns `true`
 * once the reply has been delivered.
 */
async function composeAndDeliverAiReply(
    event: AiChannelMessageEvent,
    logger: ReturnType<typeof getLogger>
): Promise<boolean> {
    // Confirm the channel is still an AI-assistant channel in this company.
    const channel = await channelService.findOne(
        { _id: new ObjectId(event.channelId), company: new ObjectId(event.companyId), isAiAssistant: true },
        { logger, languageCode: event.languageCode }
    );
    if (!channel) {
        logger.warn(`AI channel ${event.channelId} not found or not an AI-assistant channel; skipping`);
        return false;
    }

    // The bot user that authors the reply, and the human it answers.
    const bot = await User.findOne({ isBot: true, companies: new ObjectId(event.companyId) }).select("_id isBot");
    const human = await User.findById(event.userId).select("username name surname");
    if (!bot) {
        logger.err(`No bot user for company ${event.companyId}; cannot answer`);
        return false;
    }
    if (!human) {
        logger.warn(`Human user ${event.userId} not found; skipping`);
        return false;
    }

    // Ask the assistant brain (empty shell until an LLM is wired in) for the reply.
    const userDisplayName =
        [human.name, human.surname].filter(Boolean).join(" ").trim() || human.username;
    const answer = await generateAssistantReply(
        {
            text: event.text,
            channelId: event.channelId,
            companyId: event.companyId,
            userId: event.userId,
            userDisplayName,
            languageCode: event.languageCode
        },
        logger
    );

    // Persist the bot's reply authored by the company bot user.
    const reply = await messageService.create(
        {
            sender: bot,
            channel: channel,
            text: EncryptString(answer),
            type: "message",
            status: "active",
            company: channel.company
        } as any,
        { logger, languageCode: event.languageCode, auditUserId: bot._id.toString() }
    );

    await channelService.updateById(
        channel._id,
        { lastAction: new Date() },
        { logger, languageCode: event.languageCode, auditUserId: bot._id.toString() }
    );

    // Deliver the reply to the human over WebSocket (same path as normal messages).
    const websocketMessage: WebSocketMessage<{ channelId: string; messageId: string }> = {
        code: WebSocketMessageCodes.NEW_MESSAGE,
        payload: {
            channelId: channel._id.toString(),
            messageId: reply._id.toString()
        },
        userIds: [event.userId]
    };
    pushWebsocketMessage(websocketMessage);

    // Mark the human's triggering message as read by the bot. Nobody else does
    // this for the AI channel (the bot has no client), so without it the user's
    // message would sit on "sent" forever. This records the delivered+read
    // timestamps and notifies the human (the sender) via MESSAGE_RECEIPT_UPDATED,
    // so their message advances to "read" once the assistant answers.
    try {
        await applyMessageReceipts({
            readerUserId: bot._id,
            channelId: event.channelId,
            companyId: new ObjectId(event.companyId),
            messageIds: [event.messageId],
            kind: "read",
            logger,
            languageCode: event.languageCode,
            auditUserId: bot._id.toString()
        });
    }
    catch (e: any) {
        // Receipt update is best-effort; a failure must not fail the delivered reply.
        logger.warn(`Failed to mark user message ${event.messageId} read by bot: ${e?.message}`);
    }

    logger.finish(`AI reply delivered in channel ${event.channelId} (message ${reply._id.toString()})`);
    return true;
}
