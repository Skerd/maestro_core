/**
 * Notification handlers for the public visitor chat.
 *
 * Auto-discovered by {@link module:registerAllNotificationHandlers}.
 *
 * @module domain/notifications/publicChatNotificationHandlers
 */

import {ObjectId} from "mongodb";
import {type NotificationEvent, notificationEventBus, NotificationEventCodes} from "@coreModule/domain/notifications/notificationEventBus";
import {createAndPushNotification} from "@coreModule/domain/notifications/notificationDomainService";
import {NotificationCategory} from "armonia/src/modules/core/api/user/private/notifications/notifications.enum";
import {NotificationImportance} from "@coreModule/database/schemas/notification/notification";
import {CONSTANTS} from "@coreModule/environment";

export function registerPublicChatNotificationHandlers(): void {
    notificationEventBus.on(
        NotificationEventCodes.PUBLIC_CHAT_HANDOFF_REQUESTED,
        async (event: NotificationEvent) => {
            const {receiverIds, payload} = event;
            const opts = {
                languageCode: (payload.languageCode as string) ?? CONSTANTS.DEFAULT_LANGUAGE,
            };

            for (const receiverId of receiverIds) {
                try {
                    await createAndPushNotification(
                        {
                            receiver: new ObjectId(receiverId),
                            company: new ObjectId(payload.companyId as string),
                            code: NotificationEventCodes.PUBLIC_CHAT_HANDOFF_REQUESTED,
                            description: "A website visitor is waiting to talk to someone",
                            content: {
                                channelId: payload.channelId,
                                visitorName: payload.visitorName,
                                entryUrl: payload.entryUrl,
                                reason: payload.reason,
                            },
                            // A person is actively waiting — this should surface
                            // ahead of routine company notifications.
                            importance: NotificationImportance.HIGH,
                            category: NotificationCategory.CHAT,
                        },
                        opts,
                    );
                }
                catch (e) {
                    console.error(`Failed to create PUBLIC_CHAT_HANDOFF_REQUESTED notification for ${receiverId}:`, e);
                }
            }
        },
    );
}
