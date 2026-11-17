/**
 * Notification Domain Service
 *
 * Creates notifications, persists to MongoDB, and pushes via WebSocket.
 *
 * @module domain/notifications/notificationDomainService
 */

import {ObjectId} from "mongodb";
import {notificationService} from "@coreModule/database/schemas/notification/notification.service";
import {pushNotificationToUsers} from "@coreModule/connections/pushNotificationToUsers";
import {notificationToDTO} from "@coreModule/utilities/mappers/notification/notificationMapper.dto";
import {
    type NotificationEvent,
    notificationEventBus,
    NotificationEventCodes
} from "@coreModule/domain/notifications/notificationEventBus";
import {NotificationCategory} from "armonia/src/modules/core/api/user/private/notifications/notifications.enum";
import {
    INotification,
    NotificationImportance,
    NotificationStatus
} from "@coreModule/database/schemas/notification/notification";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {sendMessagingNotification} from "@coreModule/utilities/messaging/messagingDispatchService";
import {sendTelegramNotification} from "@coreModule/utilities/messaging/telegramDispatchService";
import {userService} from "@coreModule/database/schemas/user/user.service";
import {NotificationDeliveryChannel} from "armonia/src/modules/core/api/user/private/notifications/notifications.enum";
import type {IUser} from "@coreModule/database/schemas/user/user";
import {notificationText, receiverLanguage} from "@coreModule/domain/notifications/notificationTexts";
import {browserAndSystem} from "@coreModule/utilities/helpers/userAgent";

const notificationLogger = getLogger("notification_domain");

/**
 * The browser and system a sign-in came from, for the sign-in notices (TD-B237): the `device` variant names them
 * ("Chrome on macOS"); without both the notice says only that someone signed in. The IP stays in `content`.
 */
function signInDevice(userAgent: string): {variant: "device"; browser: string; os: string} | Record<string, never> {
    const {browser, os} = browserAndSystem(userAgent);
    return browser && os ? {variant: "device", browser, os} : {};
}

export interface CreateNotificationInput {
    receiver: ObjectId;
    sender?: ObjectId;
    company: ObjectId;
    code: string;
    /** English text, kept as the fallback where no module declares a translation for `code` (D117). */
    description?: string;
    /**
     * Values for the code's translated message, looked up by `code` in the module's
     * `armonia/src/modules/<module>/helpers/static/notificationTypes/*.json` by the panel and, for SMS/WhatsApp/Telegram,
     * by the server in the receiver's language (D117, D128). `variant` picks one of the code's message variants.
     */
    params?: Record<string, string | number>;
    content?: Record<string, unknown>;
    extraMessages?: unknown[];
    importance?: NotificationImportance;
    status?: NotificationStatus;
    category?: string;
    channels?: string[];
    metadata?: Record<string, unknown>;
}

/**
 * Build options for persistence from an event. Does not forward `session`: async EventEmitter
 * listeners are not awaited, so inserts would often run after the request transaction commits
 * (MongoServerError 256).
 */
function createNotifOpts(event: NotificationEvent): {
    languageCode: string;
} {
    return {
        languageCode: (event.payload.languageCode as string) ?? "en-US",
    };
}

/**
 * The receivers among `receiverIds` who have not turned `code` off in the company (D117). Module code that sends its
 * own email (or other message) for a notification type filters its recipients through this, so one preference
 * covers the in-app notice and the email. Security notices are never filtered: call this only for module types.
 */
export async function filterUnmutedReceivers(receiverIds: string[], companyId: ObjectId | string, code: string): Promise<string[]> {
    const ids = receiverIds.filter((id) => ObjectId.isValid(id));
    const muted = await userService.findUsersMutingNotification(
        ids.map((id) => new ObjectId(id)),
        new ObjectId(companyId.toString()),
        code,
    );
    return ids.filter((id) => !muted.has(id));
}

/**
 * Sends the notice to the receiver's SMS/WhatsApp (when `channels` asks for it) and linked Telegram chat, written in the
 * receiver's language (D128): the code's text from the shared notification texts, else the stored English
 * `description`. Failures are logged, never thrown: the in-app notice already exists.
 */
async function dispatchToReceiverChannels(input: Pick<CreateNotificationInput, "receiver" | "company" | "code" | "description" | "params" | "channels">): Promise<void> {
    const {receiver, company, code, description, params, channels} = input;
    const needsSms = channels?.includes(NotificationDeliveryChannel.SMS) ?? false;
    const needsWhatsapp = channels?.includes(NotificationDeliveryChannel.WHATSAPP) ?? false;

    let receiverUser: Pick<IUser, "phoneNumber" | "telegram" | "preferredLanguage"> | null;
    try {
        receiverUser = await userService.findById(receiver, {}, undefined, "phoneNumber telegram.chatId preferredLanguage");
    } catch (e) {
        notificationLogger.warn(`Receiver lookup for messaging failed: ${e instanceof Error ? e.message : String(e)}`);
        return;
    }
    const phone = receiverUser?.phoneNumber;
    const chatId = receiverUser?.telegram?.chatId;
    if (!(phone && (needsSms || needsWhatsapp)) && !chatId) return;

    const body = notificationText(code, params, receiverLanguage(receiverUser)) ?? description;
    if (!body) return;

    if (phone && (needsSms || needsWhatsapp)) {
        try {
            await sendMessagingNotification({to: phone, body, channel: needsWhatsapp ? "whatsapp" : "sms", companyId: company});
        } catch (e) {
            // Non-fatal — log but don't fail the notification creation
            notificationLogger.warn(`Messaging dispatch failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    if (chatId) {
        try {
            await sendTelegramNotification({chatId, body});
        } catch (e) {
            // Non-fatal — log but don't fail the notification creation
            notificationLogger.warn(`Telegram dispatch failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
}

/**
 * Create a notification, persist to MongoDB, and push via WebSocket. Returns `null` without writing when the receiver
 * turned this code off in the company (D117); security notices are always created.
 */
export async function createAndPushNotification(
    params: CreateNotificationInput,
    opts?: { logger?: serverLogger; auditUserId?: string; languageCode?: string; session?: any }
): Promise<INotification | null> {
    const { receiver, sender, company, code, description, params: messageParams, content, extraMessages, importance, status, category, channels, metadata } = params;
    const logger = opts?.logger;

    if (category !== NotificationCategory.SECURITY) {
        const muted = await userService.findUsersMutingNotification([receiver], company, code);
        if (muted.has(receiver.toString())) {
            return null;
        }
    }

    const doc = await notificationService.create(
        {
            receiver,
            sender: sender ?? company,
            company,
            code,
            description,
            params: messageParams,
            content,
            extraMessages: extraMessages ?? [],
            importance: importance ?? NotificationImportance.NORMAL,
            status: status ?? NotificationStatus.Info,
            category: category ?? NotificationCategory.SYSTEM,
            channels: channels ?? undefined,
            metadata
        },
        {
            logger,
            auditUserId: opts?.auditUserId,
            languageCode: opts?.languageCode ?? "en-US",
            session: opts?.session
        }
    );

    const populated = await notificationService.findByIdOrThrow(
        doc._id,
        { logger, languageCode: opts?.languageCode ?? "en-US", session: opts?.session },
        [
            { path: "sender", select: "username _id" },
            { path: "receiver", select: "username _id" },
            { path: "company", select: "name _id" }
        ]
    );

    const dto = notificationToDTO(populated);
    pushNotificationToUsers([receiver.toString()], [dto]);

    await dispatchToReceiverChannels({receiver, company, code, description, params: messageParams, channels});

    return populated;
}


/**
 * Register event handlers that create notifications on domain events.
 */
export function registerNotificationEventHandlers(): void {
    notificationEventBus.on(NotificationEventCodes.MESSAGE_MENTIONED, async (event: NotificationEvent) => {
        const { receiverIds, payload } = event;
        const senderId = payload.senderId as string;
        const companyId = payload.companyId as string;
        const channelId = payload.channelId as string;
        const senderUsername = (payload.senderUsername as string) ?? "Someone";
        const channelName = (payload.channelName as string) ?? "a channel";
        const opts = createNotifOpts(event);

        for (const receiverId of receiverIds) {
            try {
                await createAndPushNotification(
                    {
                        receiver: new ObjectId(receiverId),
                        sender: new ObjectId(senderId),
                        company: new ObjectId(companyId),
                        code: NotificationEventCodes.MESSAGE_MENTIONED,
                        description: `${senderUsername} mentioned you in ${channelName}`,
                        params: {sender: senderUsername, channel: channelName},
                        content: {
                            channelId,
                            messageId: payload.messageId,
                            senderId,
                            senderUsername
                        },
                        importance: NotificationImportance.HIGH,
                        category: NotificationCategory.CHAT
                    },
                    opts
                );
            } catch (e) {
                notificationLogger.err(`Failed to create MESSAGE_MENTIONED notification for ${receiverId}: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
    });

    notificationEventBus.on(NotificationEventCodes.ROLE_ASSIGNED, async (event: NotificationEvent) => {
        const { receiverIds, payload } = event;
        const companyId = payload.companyId as string;
        const roleName = (payload.roleName as string) ?? "a role";
        // The roles' slugs, in `roleName`'s order: the panel shows a default role's name translated (D118).
        const roleSlugs = typeof payload.roleSlugs === "string" ? payload.roleSlugs : undefined;
        const assignerUsername = (payload.assignerUsername as string) ?? "An administrator";
        const opts = createNotifOpts(event);

        for (const receiverId of receiverIds) {
            try {
                await createAndPushNotification(
                    {
                        receiver: new ObjectId(receiverId),
                        sender: payload.assignerId ? new ObjectId(payload.assignerId as string) : undefined,
                        company: new ObjectId(companyId),
                        code: NotificationEventCodes.ROLE_ASSIGNED,
                        description: `${assignerUsername} assigned you the role: ${roleName}`,
                        params: {assigner: assignerUsername, role: roleName, ...(roleSlugs ? {roleSlugs} : {})},
                        content: { roleName, roleId: payload.roleId },
                        importance: NotificationImportance.MEDIUM,
                        category: NotificationCategory.COMPANY
                    },
                    opts
                );
            } catch (e) {
                notificationLogger.err(`Failed to create ROLE_ASSIGNED notification for ${receiverId}: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
    });

    notificationEventBus.on(NotificationEventCodes.USER_LOGGED_IN, async (event: NotificationEvent) => {
        const { receiverIds, payload } = event;
        const companyId = payload.companyId as string;
        const ip = (payload.requestIp as string) ?? "";
        const userAgent = (payload.userAgent as string) ?? "";
        const source = (payload.source as string) ?? "";
        const device = signInDevice(userAgent);
        const opts = createNotifOpts(event);

        for (const receiverId of receiverIds) {
            try {
                await createAndPushNotification(
                    {
                        receiver: new ObjectId(receiverId),
                        company: new ObjectId(companyId),
                        code: NotificationEventCodes.USER_LOGGED_IN,
                        description: "browser" in device ? `New sign-in to your account from ${device.browser} on ${device.os}` : "New sign-in to your account",
                        params: device,
                        content: { requestIp: ip, userAgent, source },
                        importance: NotificationImportance.MEDIUM,
                        category: NotificationCategory.SECURITY
                    },
                    opts
                );
            } catch (e) {
                notificationLogger.err(`Failed to create USER_LOGGED_IN notification for ${receiverId}: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
    });

    notificationEventBus.on(NotificationEventCodes.USER_LOGGED_IN_NEW_DEVICE, async (event: NotificationEvent) => {
        const { receiverIds, payload } = event;
        const companyId = payload.companyId as string;
        const device = signInDevice((payload.userAgent as string) ?? "");
        const opts = createNotifOpts(event);

        for (const receiverId of receiverIds) {
            try {
                await createAndPushNotification(
                    {
                        receiver: new ObjectId(receiverId),
                        company: new ObjectId(companyId),
                        code: NotificationEventCodes.USER_LOGGED_IN_NEW_DEVICE,
                        description: "browser" in device
                            ? `Your account was used to sign in from a new device: ${device.browser} on ${device.os}`
                            : "Your account was used to sign in from a new device",
                        params: device,
                        content: {
                            requestIp: payload.requestIp,
                            userAgent: payload.userAgent,
                            source: payload.source
                        },
                        importance: NotificationImportance.HIGH,
                        category: NotificationCategory.SECURITY
                    },
                    opts
                );
            } catch (e) {
                notificationLogger.err(`Failed to create USER_LOGGED_IN_NEW_DEVICE notification for ${receiverId}: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
    });

    notificationEventBus.on(NotificationEventCodes.MFA_DISABLED, async (event: NotificationEvent) => {
        const { receiverIds, payload } = event;
        const companyId = payload.companyId as string;
        const opts = createNotifOpts(event);

        for (const receiverId of receiverIds) {
            try {
                await createAndPushNotification(
                    {
                        receiver: new ObjectId(receiverId),
                        company: new ObjectId(companyId),
                        code: NotificationEventCodes.MFA_DISABLED,
                        description: "Multi-factor authentication was disabled on your account",
                        content: {},
                        importance: NotificationImportance.HIGH,
                        category: NotificationCategory.SECURITY
                    },
                    opts
                );
            } catch (e) {
                notificationLogger.err(`Failed to create MFA_DISABLED notification for ${receiverId}: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
    });

    notificationEventBus.on(NotificationEventCodes.MFA_ENABLED, async (event: NotificationEvent) => {
        const { receiverIds, payload } = event;
        const companyId = payload.companyId as string;
        const opts = createNotifOpts(event);

        for (const receiverId of receiverIds) {
            try {
                await createAndPushNotification(
                    {
                        receiver: new ObjectId(receiverId),
                        company: new ObjectId(companyId),
                        code: NotificationEventCodes.MFA_ENABLED,
                        description: "Multi-factor authentication was enabled on your account",
                        content: {},
                        importance: NotificationImportance.HIGH,
                        category: NotificationCategory.SECURITY
                    },
                    opts
                );
            } catch (e) {
                notificationLogger.err(`Failed to create MFA_ENABLED notification for ${receiverId}: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
    });

    notificationEventBus.on(NotificationEventCodes.TELEGRAM_LINKED, async (event: NotificationEvent) => {
        const { receiverIds, payload } = event;
        const companyId = payload.companyId as string;
        const opts = createNotifOpts(event);

        for (const receiverId of receiverIds) {
            try {
                await createAndPushNotification(
                    {
                        receiver: new ObjectId(receiverId),
                        company: new ObjectId(companyId),
                        code: NotificationEventCodes.TELEGRAM_LINKED,
                        description: "Telegram was linked to your account",
                        content: {},
                        importance: NotificationImportance.MEDIUM,
                        category: NotificationCategory.SECURITY
                    },
                    opts
                );
            } catch (e) {
                notificationLogger.err(`Failed to create TELEGRAM_LINKED notification for ${receiverId}: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
    });

    notificationEventBus.on(NotificationEventCodes.TELEGRAM_UNLINKED, async (event: NotificationEvent) => {
        const { receiverIds, payload } = event;
        const companyId = payload.companyId as string;
        const opts = createNotifOpts(event);

        for (const receiverId of receiverIds) {
            try {
                await createAndPushNotification(
                    {
                        receiver: new ObjectId(receiverId),
                        company: new ObjectId(companyId),
                        code: NotificationEventCodes.TELEGRAM_UNLINKED,
                        description: "Telegram was unlinked from your account",
                        content: {},
                        importance: NotificationImportance.MEDIUM,
                        category: NotificationCategory.SECURITY
                    },
                    opts
                );
            } catch (e) {
                notificationLogger.err(`Failed to create TELEGRAM_UNLINKED notification for ${receiverId}: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
    });

    notificationEventBus.on(NotificationEventCodes.ACCOUNT_SELF_DEACTIVATED, async (event: NotificationEvent) => {
        const { receiverIds, payload } = event;
        const companyId = payload.companyId as string;
        const opts = createNotifOpts(event);

        for (const receiverId of receiverIds) {
            try {
                await createAndPushNotification(
                    {
                        receiver: new ObjectId(receiverId),
                        company: new ObjectId(companyId),
                        code: NotificationEventCodes.ACCOUNT_SELF_DEACTIVATED,
                        description: "You deactivated your account for this company",
                        content: {},
                        importance: NotificationImportance.HIGH,
                        category: NotificationCategory.SECURITY
                    },
                    opts
                );
            } catch (e) {
                notificationLogger.err(`Failed to create ACCOUNT_SELF_DEACTIVATED notification for ${receiverId}: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
    });

    notificationEventBus.on(NotificationEventCodes.ACCOUNT_STATUS_CHANGED_BY_ADMIN, async (event: NotificationEvent) => {
        const { receiverIds, payload } = event;
        const companyId = payload.companyId as string;
        const activated = Boolean(payload.activated);
        const actorUsername = (payload.actorUsername as string) ?? "An administrator";
        const opts = createNotifOpts(event);
        const description = activated
            ? `${actorUsername} activated your account for this company`
            : `${actorUsername} deactivated your account for this company`;

        for (const receiverId of receiverIds) {
            try {
                await createAndPushNotification(
                    {
                        receiver: new ObjectId(receiverId),
                        sender: payload.actorId ? new ObjectId(payload.actorId as string) : undefined,
                        company: new ObjectId(companyId),
                        code: NotificationEventCodes.ACCOUNT_STATUS_CHANGED_BY_ADMIN,
                        description,
                        params: {actor: actorUsername, variant: activated ? "activated" : "deactivated"},
                        content: { activated, actorId: payload.actorId },
                        importance: NotificationImportance.HIGH,
                        category: NotificationCategory.SECURITY
                    },
                    opts
                );
            } catch (e) {
                notificationLogger.err(`Failed to create ACCOUNT_STATUS_CHANGED_BY_ADMIN notification for ${receiverId}: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
    });

    notificationEventBus.on(NotificationEventCodes.INVITATION_RECEIVED, async (event: NotificationEvent) => {
        const { receiverIds, payload } = event;
        const companyId = payload.companyId as string;
        const companyName = (payload.companyName as string) ?? "the company";
        const inviterName = (payload.inviterName as string) ?? "Someone";
        const opts = createNotifOpts(event);

        for (const receiverId of receiverIds) {
            try {
                await createAndPushNotification(
                    {
                        receiver: new ObjectId(receiverId),
                        sender: payload.inviterId ? new ObjectId(payload.inviterId as string) : undefined,
                        company: new ObjectId(companyId),
                        code: NotificationEventCodes.INVITATION_RECEIVED,
                        description: `${inviterName} invited you to join ${companyName}`,
                        params: {inviter: inviterName, company: companyName},
                        content: {
                            companyName,
                            inviterId: payload.inviterId,
                            inviterName
                        },
                        importance: NotificationImportance.MEDIUM,
                        category: NotificationCategory.COMPANY
                    },
                    opts
                );
            } catch (e) {
                notificationLogger.err(`Failed to create INVITATION_RECEIVED notification for ${receiverId}: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
    });

    notificationEventBus.on(NotificationEventCodes.ACCOUNT_ACTIVATED, async (event: NotificationEvent) => {
        const { receiverIds, payload } = event;
        const companyId = payload.companyId as string;
        const variant = (payload.variant as string) ?? "email";
        const opts = createNotifOpts(event);
        const description =
            variant === "invitation"
                ? "Your account is now active. You can sign in."
                : "Your email was verified and your account is active";

        for (const receiverId of receiverIds) {
            try {
                await createAndPushNotification(
                    {
                        receiver: new ObjectId(receiverId),
                        company: new ObjectId(companyId),
                        code: NotificationEventCodes.ACCOUNT_ACTIVATED,
                        description,
                        params: {variant},
                        content: { variant },
                        importance: NotificationImportance.MEDIUM,
                        category: NotificationCategory.COMPANY
                    },
                    opts
                );
            } catch (e) {
                notificationLogger.err(`Failed to create ACCOUNT_ACTIVATED notification for ${receiverId}: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
    });

    notificationEventBus.on(NotificationEventCodes.COMPANY_UPDATED, async (event: NotificationEvent) => {
        const { receiverIds, payload } = event;
        const companyId = payload.companyId as string;
        const companyName = (payload.companyName as string) ?? "the company";
        const updatedByUsername = (payload.updatedByUsername as string) ?? "Someone";
        const opts = createNotifOpts(event);

        for (const receiverId of receiverIds) {
            try {
                await createAndPushNotification(
                    {
                        receiver: new ObjectId(receiverId),
                        sender: payload.updatedByUserId ? new ObjectId(payload.updatedByUserId as string) : undefined,
                        company: new ObjectId(companyId),
                        code: NotificationEventCodes.COMPANY_UPDATED,
                        description: `${updatedByUsername} updated company profile for ${companyName}`,
                        params: {user: updatedByUsername, company: companyName},
                        content: {
                            companyName,
                            updatedByUserId: payload.updatedByUserId
                        },
                        importance: NotificationImportance.LOW,
                        category: NotificationCategory.COMPANY
                    },
                    opts
                );
            } catch (e) {
                notificationLogger.err(`Failed to create COMPANY_UPDATED notification for ${receiverId}: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
    });
}
