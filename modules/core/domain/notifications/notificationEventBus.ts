/**
 * Notification Event Bus
 *
 * In-process event emitter for notification-triggering domain events.
 * Handlers subscribe and create + push notifications.
 *
 * Feature modules own their event code constants; core only defines core codes.
 *
 * @module domain/notifications/notificationEventBus
 */

import {EventEmitter} from "events";
import type {ClientSession} from "mongodb";

/** Core-platform notification event codes only. Module codes live under each package. */
export const NotificationEventCodes = {
    USER_LOGGED_IN: "USER_LOGGED_IN",
    USER_LOGGED_IN_NEW_DEVICE: "USER_LOGGED_IN_NEW_DEVICE",
    MESSAGE_MENTIONED: "MESSAGE_MENTIONED",
    ROLE_ASSIGNED: "ROLE_ASSIGNED",
    TRANSACTION_COMPLETED: "TRANSACTION_COMPLETED",
    MFA_DISABLED: "MFA_DISABLED",
    MFA_ENABLED: "MFA_ENABLED",
    TELEGRAM_LINKED: "TELEGRAM_LINKED",
    TELEGRAM_UNLINKED: "TELEGRAM_UNLINKED",
    INVITATION_RECEIVED: "INVITATION_RECEIVED",
    ACCOUNT_ACTIVATED: "ACCOUNT_ACTIVATED",
    ACCOUNT_SELF_DEACTIVATED: "ACCOUNT_SELF_DEACTIVATED",
    ACCOUNT_STATUS_CHANGED_BY_ADMIN: "ACCOUNT_STATUS_CHANGED_BY_ADMIN",
    COMPANY_UPDATED: "COMPANY_UPDATED",
    SYSTEM_MAINTENANCE: "SYSTEM_MAINTENANCE",
} as const;

export interface NotificationEvent {
    code: string;
    receiverIds: string[];
    payload: Record<string, unknown>;
    /**
     * Optional session from the caller for future use only. Persisted notifications do not use
     * it: async EventEmitter handlers can run after the request transaction commits, which makes
     * binding writes to `session` unsafe (MongoServerError 256).
     */
    session?: ClientSession;
}

export type NotificationEventCode = string;

export type EmitNotificationEventArgs = {
    receiverIds: string[];
    payload: Record<string, unknown>;
    /** Ignored for DB writes — see {@link NotificationEvent.session}. */
    session?: ClientSession;
};

export const notificationEventBus = new EventEmitter();
notificationEventBus.setMaxListeners(50);

/**
 * Emit a notification domain event; registered handlers create and push notifications.
 */
export function emitNotificationEvent(code: string, args: EmitNotificationEventArgs): void {
    const payload: NotificationEvent = {
        code,
        receiverIds: args.receiverIds,
        payload: args.payload,
        session: args.session
    };
    notificationEventBus.emit(code, payload);
}
