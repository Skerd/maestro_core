/**
 * Notification handlers for requested entries of the platform lists (requestablePlugin, D160): a company requests an
 * entry, the platform approves or rejects it, and the requester hears the outcome.
 *
 * Auto-discovered by {@link module:registerAllNotificationHandlers}.
 *
 * @module domain/notifications/entryRequestNotificationHandlers
 */

import {ObjectId} from "mongodb";
import {type NotificationEvent, notificationEventBus, NotificationEventCodes} from "@coreModule/domain/notifications/notificationEventBus";
import {createAndPushNotification} from "@coreModule/domain/notifications/notificationDomainService";
import {NotificationCategory} from "armonia/src/modules/core/api/user/private/notifications/notifications.enum";
import {NotificationImportance} from "@coreModule/database/schemas/notification/notification";
import {CONSTANTS} from "@coreModule/environment";
import {getLogger} from "@coreModule/loggers/serverLog";

const DESCRIPTIONS: Record<string, string> = {
    [NotificationEventCodes.ENTRY_REQUESTED]: "A company requested a new list entry",
    [NotificationEventCodes.ENTRY_REQUEST_APPROVED]: "Your requested entry was approved",
    [NotificationEventCodes.ENTRY_REQUEST_REJECTED]: "Your requested entry was rejected",
};

const text = (value: unknown): string => (value == null ? "" : String(value));

async function notify(event: NotificationEvent): Promise<void> {
    const {code, receiverIds, payload} = event;
    const opts = {languageCode: text(payload.languageCode) || CONSTANTS.DEFAULT_LANGUAGE};
    for (const receiverId of receiverIds) {
        try {
            await createAndPushNotification(
                {
                    receiver: new ObjectId(receiverId),
                    company: new ObjectId(text(payload.companyId)),
                    code,
                    description: DESCRIPTIONS[code],
                    params: {
                        name: text(payload.name),
                        company: text(payload.requesterCompanyName),
                        notes: text(payload.notes),
                        ...(payload.variant ? {variant: text(payload.variant)} : {}),
                    },
                    // The list page and the entry the notice opens.
                    content: {list: payload.list, entryId: payload.entryId},
                    importance: NotificationImportance.NORMAL,
                    category: NotificationCategory.SYSTEM,
                },
                opts,
            );
        } catch (e) {
            getLogger("entry_request_notifications").err(`Failed to create ${code} notification for ${receiverId}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
}

export function registerEntryRequestNotificationHandlers(): void {
    notificationEventBus.on(NotificationEventCodes.ENTRY_REQUESTED, notify);
    notificationEventBus.on(NotificationEventCodes.ENTRY_REQUEST_APPROVED, notify);
    notificationEventBus.on(NotificationEventCodes.ENTRY_REQUEST_REJECTED, notify);
}
