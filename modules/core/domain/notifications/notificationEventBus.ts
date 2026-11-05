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
import {withTenant} from "@coreModule/utilities/endpoints/tenantScope";
import {runAfterCommit} from "@coreModule/utilities/middlewares/transactionUtils";

/** Core-platform notification event codes only. Module codes live under each package. */
export const NotificationEventCodes = {
    USER_LOGGED_IN: "USER_LOGGED_IN",
    USER_LOGGED_IN_NEW_DEVICE: "USER_LOGGED_IN_NEW_DEVICE",
    MESSAGE_MENTIONED: "MESSAGE_MENTIONED",
    ROLE_ASSIGNED: "ROLE_ASSIGNED",
    MFA_DISABLED: "MFA_DISABLED",
    MFA_ENABLED: "MFA_ENABLED",
    TELEGRAM_LINKED: "TELEGRAM_LINKED",
    TELEGRAM_UNLINKED: "TELEGRAM_UNLINKED",
    INVITATION_RECEIVED: "INVITATION_RECEIVED",
    ACCOUNT_ACTIVATED: "ACCOUNT_ACTIVATED",
    ACCOUNT_SELF_DEACTIVATED: "ACCOUNT_SELF_DEACTIVATED",
    ACCOUNT_STATUS_CHANGED_BY_ADMIN: "ACCOUNT_STATUS_CHANGED_BY_ADMIN",
    COMPANY_UPDATED: "COMPANY_UPDATED",
    /** A public-website visitor is waiting for a human to join their chat. */
    PUBLIC_CHAT_HANDOFF_REQUESTED: "PUBLIC_CHAT_HANDOFF_REQUESTED",
} as const;

export interface NotificationEvent {
    code: string;
    receiverIds: string[];
    payload: Record<string, unknown>;
    /**
     * The caller's session. The event waits for its transaction to commit (D06); handlers never write
     * with it (they run after the commit, MongoServerError 256).
     */
    session?: ClientSession;
}

export type NotificationEventCode = string;

export type EmitNotificationEventArgs = {
    receiverIds: string[];
    payload: Record<string, unknown>;
    /** Only to wait for its commit; the request's own transaction is waited for without it. */
    session?: ClientSession;
};

export const notificationEventBus = new EventEmitter();
notificationEventBus.setMaxListeners(50);

/**
 * Emit a notification domain event; registered handlers create and push notifications. Inside a
 * transaction (the caller's `session`, or the request's) the event waits for the commit and is dropped
 * on a rollback or a retried attempt, so nobody is told about work that did not happen (D06).
 */
export function emitNotificationEvent(code: string, args: EmitNotificationEventArgs): void {
    // Without a transaction the task runs synchronously, before runAfterCommit's first await.
    void runAfterCommit(args.session, async () => publish(code, args));
}

function publish(code: string, args: EmitNotificationEventArgs): void {
    const payload: NotificationEvent = {
        code,
        receiverIds: args.receiverIds,
        payload: args.payload,
        session: args.session
    };
    // Handlers write the notification under the event's company, whichever request raised it: a
    // public activation has no tenant, a company switch another one (D16). Same rule as the Kafka consumer.
    const companyId = args.payload.companyId == null ? "" : String(args.payload.companyId);
    if (!companyId) {
        notificationEventBus.emit(code, payload);
        return;
    }
    void withTenant(companyId, () => {
        notificationEventBus.emit(code, payload);
    });
}
