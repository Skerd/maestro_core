/**
 * Notification handlers of self-serve business sign-up (D178): the platform's admins hear of each new company waiting
 * for approval, and the company's admins hear what the platform decided about listing it on the portal apex.
 *
 * Auto-discovered by {@link module:registerAllNotificationHandlers}.
 *
 * @module domain/notifications/companySignupNotificationHandlers
 */

import {ObjectId} from "mongodb";
import {type NotificationEvent, notificationEventBus, NotificationEventCodes} from "@coreModule/domain/notifications/notificationEventBus";
import {createAndPushNotification} from "@coreModule/domain/notifications/notificationDomainService";
import {NotificationCategory} from "armonia/src/modules/core/api/user/private/notifications/notifications.enum";
import {NotificationImportance} from "@coreModule/database/schemas/notification/notification";
import {CONSTANTS} from "@coreModule/environment";
import {getLogger} from "@coreModule/loggers/serverLog";

const DESCRIPTIONS: Record<string, string> = {
    [NotificationEventCodes.COMPANY_SIGNED_UP]: "A new business signed up and waits for approval",
    [NotificationEventCodes.COMPANY_PORTAL_APPROVED]: "Your business is listed on the portal",
    [NotificationEventCodes.COMPANY_PORTAL_REJECTED]: "Your business was not listed on the portal",
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
                        reason: text(payload.reason),
                        ...(payload.variant ? {variant: text(payload.variant)} : {}),
                    },
                    // The company the notice is about, which it opens on the Companies page.
                    content: {companyId: payload.subjectCompanyId},
                    importance: code === NotificationEventCodes.COMPANY_SIGNED_UP ? NotificationImportance.HIGH : NotificationImportance.NORMAL,
                    category: NotificationCategory.SYSTEM,
                },
                opts,
            );
        } catch (e) {
            getLogger("company_signup_notifications").err(`Failed to create ${code} notification for ${receiverId}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
}

export function registerCompanySignupNotificationHandlers(): void {
    notificationEventBus.on(NotificationEventCodes.COMPANY_SIGNED_UP, notify);
    notificationEventBus.on(NotificationEventCodes.COMPANY_PORTAL_APPROVED, notify);
    notificationEventBus.on(NotificationEventCodes.COMPANY_PORTAL_REJECTED, notify);
}
