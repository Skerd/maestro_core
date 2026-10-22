/**
 * Push notifications to users via WebSocket
 *
 * Sends notification payloads to the WebSocket server (machine connection)
 * for real-time delivery to specified user IDs.
 *
 * @module pushNotificationToUsers
 */

import {pushWebsocketMessage} from "@coreModule/connections/connectToWebSocketServer";
import {NotificationType} from "armonia/src/modules/core/api/user/private/notifications/notifications.dto";
import {WebSocketMessageCodes} from "armonia/src/modules/core/websocket/types";

/**
 * Push notifications to specified users via WebSocket.
 * Fire-and-forget; no-op if WebSocket is not connected. The notifications are
 * already stored, so a dropped push only delays them until the next fetch.
 *
 * @param userIds - User IDs to receive the notifications
 * @param notifications - Notification DTOs to push
 */
export function pushNotificationToUsers(
    userIds: string[],
    notifications: NotificationType[]
): void {
    if (userIds.length === 0 || notifications.length === 0) {
        return;
    }

    pushWebsocketMessage({
        code: WebSocketMessageCodes.NEW_NOTIFICATIONS,
        userIds,
        payload: notifications
    });
}
