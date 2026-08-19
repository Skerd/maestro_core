import Notification, {NotificationImportance, NotificationStatus} from "./notification";
import User from "@coreModule/database/schemas/user/user";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {ICompany} from "@coreModule/database/schemas/company/company";
import {
    NotificationCategory,
    NotificationDeliveryChannel,
} from "armonia/src/modules/core/api/user/private/notifications/notifications.enum";

const DEMO_NOTIFICATIONS: readonly {
    code: string;
    description: string;
    receiver: string;
    importance: NotificationImportance;
    status: NotificationStatus;
    category: NotificationCategory;
}[] = [
    {
        code: "core-demo-seed:welcome",
        description: "Welcome to Pronix — demo data is ready.",
        receiver: "echo@echo.com",
        importance: NotificationImportance.NORMAL,
        status: NotificationStatus.Success,
        category: NotificationCategory.SYSTEM,
    },
    {
        code: "core-demo-seed:gift-card-issued",
        description: "Gift card DEMO-GIFT-50 was issued from DEMO-ORD-1008.",
        receiver: "almir@leka.com",
        importance: NotificationImportance.MEDIUM,
        status: NotificationStatus.Info,
        category: NotificationCategory.FINANCIAL,
    },
];

/**
 * Two in-app notifications so the bell is not empty on a fresh init.
 * Idempotent on `{receiver, code}`.
 */
export async function createNotifications(
    parentLogger: serverLogger,
    company: ICompany,
): Promise<void> {
    const logger = getLogger("mongoDbInitialization-createNotifications", parentLogger);
    logger.start("Creating demo notifications...");

    try {
        const sender = await User.findOne({username: "echo@echo.com"}).select("_id");
        if (!sender) {
            logger.warn("Skipping notifications: sender echo@echo.com not found.");
            logger.finish("Finished creating demo notifications!", 0);
            return;
        }

        let created = 0;
        for (const row of DEMO_NOTIFICATIONS) {
            const receiver = await User.findOne({username: row.receiver}).select("_id");
            if (!receiver) {
                logger.warn(`Skipping notification ${row.code}: receiver "${row.receiver}" not found.`);
                continue;
            }

            const payload = {
                sender: sender._id,
                receiver: receiver._id,
                company: company._id,
                code: row.code,
                description: row.description,
                extraMessages: [],
                date: new Date(),
                importance: row.importance,
                status: row.status,
                category: row.category,
                channels: [NotificationDeliveryChannel.IN_APP],
                createdBy: sender._id,
            };

            const existing = await Notification.findOne({
                receiver: receiver._id,
                code: row.code,
            });
            if (existing) {
                existing.set(payload);
                await existing.save();
            } else {
                await Notification.create(payload);
            }
            created += 1;
        }

        logger.finish("Finished creating demo notifications!", created);
    } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        logger.err(`Error creating demo notifications: ${message}`);
        logger.fail("Failed to create demo notifications!");
    }
}
