/**
 * Notification handlers of the platform's upload review (D177): the platform's reviewers hear of flagged uploads, and
 * whoever uploaded a flagged file hears what the review decided.
 *
 * Auto-discovered by {@link module:registerAllNotificationHandlers}.
 *
 * @module domain/notifications/uploadReviewNotificationHandlers
 */

import {ObjectId} from "mongodb";
import {type NotificationEvent, notificationEventBus, NotificationEventCodes} from "@coreModule/domain/notifications/notificationEventBus";
import {createAndPushNotification} from "@coreModule/domain/notifications/notificationDomainService";
import {NotificationCategory} from "armonia/src/modules/core/api/user/private/notifications/notifications.enum";
import {NotificationImportance} from "@coreModule/database/schemas/notification/notification";
import {CONSTANTS} from "@coreModule/environment";
import {getLogger} from "@coreModule/loggers/serverLog";

const DESCRIPTIONS: Record<string, string> = {
    [NotificationEventCodes.UPLOAD_FLAGGED]: "An upload was flagged for review",
    [NotificationEventCodes.UPLOAD_REVIEW_APPROVED]: "Your flagged file was approved",
    [NotificationEventCodes.UPLOAD_REVIEW_REMOVED]: "Your flagged file was removed",
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
                        company: text(payload.uploaderCompanyName),
                        count: text(payload.count),
                        ...(payload.variant ? {variant: text(payload.variant)} : {}),
                    },
                    content: {mediaId: payload.mediaId},
                    importance: code === NotificationEventCodes.UPLOAD_FLAGGED ? NotificationImportance.HIGH : NotificationImportance.NORMAL,
                    category: NotificationCategory.SYSTEM,
                },
                opts,
            );
        } catch (e) {
            getLogger("upload_review_notifications").err(`Failed to create ${code} notification for ${receiverId}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
}

export function registerUploadReviewNotificationHandlers(): void {
    notificationEventBus.on(NotificationEventCodes.UPLOAD_FLAGGED, notify);
    notificationEventBus.on(NotificationEventCodes.UPLOAD_REVIEW_APPROVED, notify);
    notificationEventBus.on(NotificationEventCodes.UPLOAD_REVIEW_REMOVED, notify);
}
