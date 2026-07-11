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
import {serverLogger} from "@coreModule/loggers/serverLog";
import {sendMessagingNotification} from "@coreModule/utilities/messaging/messagingDispatchService";
import {sendTelegramNotification} from "@coreModule/utilities/messaging/telegramDispatchService";
import User from "@coreModule/database/schemas/user/user";
import {NotificationDeliveryChannel} from "armonia/src/modules/core/api/user/private/notifications/notifications.enum";

export interface CreateNotificationInput {
    receiver: ObjectId;
    sender?: ObjectId;
    company: ObjectId;
    code: string;
    description?: string;
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
 * Create a notification, persist to MongoDB, and push via WebSocket.
 */
export async function createAndPushNotification(
    params: CreateNotificationInput,
    opts?: { logger?: serverLogger; auditUserId?: string; languageCode?: string; session?: any }
): Promise<INotification> {
    const { receiver, sender, company, code, description, content, extraMessages, importance, status, category, channels, metadata } = params;
    const logger = opts?.logger;

    const doc = await notificationService.create(
        {
            //@ts-expect-error
            receiver,
            //@ts-expect-error
            sender: sender ?? company,
            //@ts-expect-error
            company,
            code,
            description,
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

    // Dispatch SMS/WhatsApp if requested
    if (channels && description) {
        const needsSms      = channels.includes(NotificationDeliveryChannel.SMS);
        const needsWhatsapp = channels.includes(NotificationDeliveryChannel.WHATSAPP);
        if (needsSms || needsWhatsapp) {
            try {
                const receiverUser = await User.findById(receiver).select("phoneNumber").lean();
                const phone = (receiverUser as any)?.phoneNumber as string | undefined;
                if (phone) {
                    const channel = needsWhatsapp ? "whatsapp" : "sms";
                    await sendMessagingNotification({to: phone, body: description, channel, companyId: company});
                }
            } catch (e) {
                // Non-fatal — log but don't fail the notification creation
                console.error("Messaging dispatch failed:", e);
            }
        }
    }

    // Auto-dispatch to Telegram when the receiver has a linked chatId
    if (description) {
        try {
            const receiverUser = await User.findById(receiver).select("telegram.chatId").lean();
            const chatId = (receiverUser as any)?.telegram?.chatId as number | undefined;
            if (chatId) {
                await sendTelegramNotification({chatId, body: description});
            }
        } catch (e) {
            // Non-fatal — log but don't fail the notification creation
            console.error("Telegram dispatch failed:", e);
        }
    }

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
                console.error(`Failed to create MESSAGE_MENTIONED notification for ${receiverId}:`, e);
            }
        }
    });

    notificationEventBus.on(NotificationEventCodes.ROLE_ASSIGNED, async (event: NotificationEvent) => {
        const { receiverIds, payload } = event;
        const companyId = payload.companyId as string;
        const roleName = (payload.roleName as string) ?? "a role";
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
                        content: { roleName, roleId: payload.roleId },
                        importance: NotificationImportance.MEDIUM,
                        category: NotificationCategory.COMPANY
                    },
                    opts
                );
            } catch (e) {
                console.error(`Failed to create ROLE_ASSIGNED notification for ${receiverId}:`, e);
            }
        }
    });

    notificationEventBus.on(NotificationEventCodes.USER_LOGGED_IN, async (event: NotificationEvent) => {
        const { receiverIds, payload } = event;
        const companyId = payload.companyId as string;
        const ip = (payload.requestIp as string) ?? "";
        const userAgent = (payload.userAgent as string) ?? "";
        const source = (payload.source as string) ?? "";
        const opts = createNotifOpts(event);

        for (const receiverId of receiverIds) {
            try {
                await createAndPushNotification(
                    {
                        receiver: new ObjectId(receiverId),
                        company: new ObjectId(companyId),
                        code: NotificationEventCodes.USER_LOGGED_IN,
                        description: `New sign-in to your account from ${source} (${ip})`,
                        content: { requestIp: ip, userAgent, source },
                        importance: NotificationImportance.MEDIUM,
                        category: NotificationCategory.SECURITY
                    },
                    opts
                );
            } catch (e) {
                console.error(`Failed to create USER_LOGGED_IN notification for ${receiverId}:`, e);
            }
        }
    });

    notificationEventBus.on(NotificationEventCodes.USER_LOGGED_IN_NEW_DEVICE, async (event: NotificationEvent) => {
        const { receiverIds, payload } = event;
        const companyId = payload.companyId as string;
        const opts = createNotifOpts(event);

        for (const receiverId of receiverIds) {
            try {
                await createAndPushNotification(
                    {
                        receiver: new ObjectId(receiverId),
                        company: new ObjectId(companyId),
                        code: NotificationEventCodes.USER_LOGGED_IN_NEW_DEVICE,
                        description: "Your account was used to sign in from a new device",
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
                console.error(`Failed to create USER_LOGGED_IN_NEW_DEVICE notification for ${receiverId}:`, e);
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
                console.error(`Failed to create MFA_DISABLED notification for ${receiverId}:`, e);
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
                console.error(`Failed to create MFA_ENABLED notification for ${receiverId}:`, e);
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
                console.error(`Failed to create TELEGRAM_LINKED notification for ${receiverId}:`, e);
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
                console.error(`Failed to create TELEGRAM_UNLINKED notification for ${receiverId}:`, e);
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
                console.error(`Failed to create ACCOUNT_SELF_DEACTIVATED notification for ${receiverId}:`, e);
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
                        content: { activated, actorId: payload.actorId },
                        importance: NotificationImportance.HIGH,
                        category: NotificationCategory.SECURITY
                    },
                    opts
                );
            } catch (e) {
                console.error(`Failed to create ACCOUNT_STATUS_CHANGED_BY_ADMIN notification for ${receiverId}:`, e);
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
                console.error(`Failed to create INVITATION_RECEIVED notification for ${receiverId}:`, e);
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
                        content: { variant },
                        importance: NotificationImportance.MEDIUM,
                        category: NotificationCategory.COMPANY
                    },
                    opts
                );
            } catch (e) {
                console.error(`Failed to create ACCOUNT_ACTIVATED notification for ${receiverId}:`, e);
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
                console.error(`Failed to create COMPANY_UPDATED notification for ${receiverId}:`, e);
            }
        }
    });

    notificationEventBus.on(NotificationEventCodes.TRANSACTION_COMPLETED, async (event: NotificationEvent) => {
        const { receiverIds, payload } = event;
        const companyId = payload.companyId as string;
        const perspective = (payload.perspective as string) ?? "receiver";
        const amountStr = (payload.amount as string) ?? "";
        const transactionType = (payload.transactionType as string) ?? "";
        const opts = createNotifOpts(event);

        const description =
            perspective === "sender"
                ? `Transaction sent: ${transactionType} ${amountStr}`
                : `Transaction received: ${transactionType} ${amountStr}`;

        for (const receiverId of receiverIds) {
            try {
                await createAndPushNotification(
                    {
                        receiver: new ObjectId(receiverId),
                        company: new ObjectId(companyId),
                        code: NotificationEventCodes.TRANSACTION_COMPLETED,
                        description,
                        content: {
                            transactionId: payload.transactionId,
                            amount: payload.amount,
                            currencyId: payload.currencyId,
                            transactionType: payload.transactionType,
                            perspective
                        },
                        importance: NotificationImportance.MEDIUM,
                        category: NotificationCategory.FINANCIAL
                    },
                    opts
                );
            } catch (e) {
                console.error(`Failed to create TRANSACTION_COMPLETED notification for ${receiverId}:`, e);
            }
        }
    });

    notificationEventBus.on(NotificationEventCodes.SYSTEM_MAINTENANCE, async (event: NotificationEvent) => {
        const { receiverIds, payload } = event;
        const companyId = payload.companyId as string;
        const message = (payload.message as string) ?? "";
        const startsAt = payload.startsAt as string | undefined;
        const endsAt = payload.endsAt as string | undefined;
        const opts = createNotifOpts(event);

        const windowParts = [startsAt, endsAt].filter(Boolean);
        const windowStr = windowParts.length ? ` (${windowParts.join(" – ")})` : "";
        const description = `Scheduled maintenance${windowStr}: ${message}`;

        for (const receiverId of receiverIds) {
            try {
                await createAndPushNotification(
                    {
                        receiver: new ObjectId(receiverId),
                        company: new ObjectId(companyId),
                        code: NotificationEventCodes.SYSTEM_MAINTENANCE,
                        description,
                        content: { message, startsAt, endsAt },
                        importance: NotificationImportance.HIGH,
                        category: NotificationCategory.SYSTEM
                    },
                    opts
                );
            } catch (e) {
                console.error(`Failed to create SYSTEM_MAINTENANCE notification for ${receiverId}:`, e);
            }
        }
    });
}
