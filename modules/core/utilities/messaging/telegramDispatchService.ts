/**
 * Telegram Dispatch Service
 *
 * Sends notification text to a linked Telegram chat via the Telegraf bot.
 * Called by the notification domain service when the receiver has telegram.chatId.
 */

import {
    executeWithCircuitBreaker,
    getTelegramBot,
    isTelegramConnected,
} from "@coreModule/connections/connectToTelegram";
import {getLogger} from "@coreModule/loggers/serverLog";

export interface SendTelegramNotificationParams {
    chatId: number;
    body: string;
}

export interface SendTelegramNotificationResult {
    messageId: number;
}

const logger = getLogger("telegramDispatchService");

/**
 * Sends a Telegram message to the given chat.
 * Returns null when the bot is unavailable or the send fails (non-fatal for callers).
 */
export async function sendTelegramNotification(
    params: SendTelegramNotificationParams,
): Promise<SendTelegramNotificationResult | null> {
    const {chatId, body} = params;
    if (!chatId || !body?.trim()) {
        return null;
    }

    if (!isTelegramConnected()) {
        logger.debug("Telegram bot not connected; skipping notification send");
        return null;
    }

    try {
        const bot = getTelegramBot();
        const message = await executeWithCircuitBreaker(async () =>
            bot.telegram.sendMessage(chatId, body),
        );
        return {messageId: message.message_id};
    } catch (err: any) {
        logger.warn(
            `Telegram notification send failed for chatId=${chatId}: ${err?.message ?? err}`,
        );
        return null;
    }
}
