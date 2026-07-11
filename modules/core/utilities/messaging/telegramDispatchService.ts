/**
 * Telegram Dispatch Service
 *
 * Sends notification text to a linked Telegram chat via the Telegraf Bot API.
 * Called by the notification domain service when the receiver has telegram.chatId.
 *
 * Long-polling / getUpdates runs only in telegramServer. This module is
 * send-only: it uses the shared Telegraf client without launch().
 */

import {
    executeWithCircuitBreaker,
    getTelegramBot,
} from "@coreModule/connections/connectToTelegram";
import {TELEGRAM} from "@coreModule/environment";
import {getLogger} from "@coreModule/loggers/serverLog";
import {telegramCounter} from "@coreModule/utilities/serviceMetrics/serviceCounters";

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
 * Returns null when the bot token is missing or the send fails (non-fatal for callers).
 */
export async function sendTelegramNotification(
    params: SendTelegramNotificationParams,
): Promise<SendTelegramNotificationResult | null> {
    const {chatId, body} = params;
    if (!chatId || !body?.trim()) {
        return null;
    }

    if (!TELEGRAM.TOKEN) {
        logger.debug("TELEGRAM_TOKEN not configured; skipping notification send");
        return null;
    }

    const started = Date.now();
    try {
        const bot = getTelegramBot();
        const message = await executeWithCircuitBreaker(async () =>
            bot.telegram.sendMessage(chatId, body),
        );
        telegramCounter.recordSuccess(Date.now() - started);
        return {messageId: message.message_id};
    } catch (err: any) {
        telegramCounter.recordFailure(Date.now() - started);
        logger.warn(
            `Telegram notification send failed for chatId=${chatId}: ${err?.message ?? err}`,
        );
        return null;
    }
}
