/**
 * Push notifications to users via WebSocket
 *
 * Sends notification payloads to the WebSocket server (machine connection)
 * for real-time delivery to specified user IDs.
 *
 * @module connectToWebSocketServer
 */

import {isWebSocketConnected, WebSocketServerLocal} from "@coreModule/connections/connectToWebSocketServer";
import {NotificationType} from "armonia/src/modules/core/api/user/private/notifications/notifications.dto";
import {WebSocketMessageCodes} from "armonia/src/modules/core/websocket/types";

/**
 * Push notifications to specified users via WebSocket.
 * No-op if WebSocket is not connected.
 *
 * @param userIds - User IDs to receive the notifications
 * @param notifications - Notification DTOs to push
 */
export function pushNotificationToUsers(
    userIds: string[],
    notifications: NotificationType[]
): void {
    if (!isWebSocketConnected() || !WebSocketServerLocal || userIds.length === 0 || notifications.length === 0) {
        return;
    }

    try {
        WebSocketServerLocal.send(
            JSON.stringify({
                code: WebSocketMessageCodes.NEW_NOTIFICATIONS,
                userIds,
                payload: notifications
            })
        );
    } catch (e) {
        // Fire-and-forget; log but don't throw
        console.error("Failed to push notifications via WebSocket:", e);
    }
}
