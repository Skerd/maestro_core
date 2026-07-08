import {Schema} from "mongoose";

export function applyNotificationIndexes(NotificationSchema: Schema): void {
    // Primary reference indexes
    NotificationSchema.index({receiver: 1});
    NotificationSchema.index({sender: 1});
    NotificationSchema.index({company: 1});

    // Notification metadata indexes
    NotificationSchema.index({code: 1});
    NotificationSchema.index({date: -1});
    NotificationSchema.index({date: 1});

    // Status and importance indexes
    NotificationSchema.index({importance: 1});
    NotificationSchema.index({status: 1});

    // Read status indexes
    NotificationSchema.index({readOn: 1});
    NotificationSchema.index({readOn: -1});

    // Compound indexes for common query patterns
    NotificationSchema.index({company: 1, createdAt: -1});
    NotificationSchema.index({createdAt: -1});
    NotificationSchema.index({receiver: 1, date: -1});
    NotificationSchema.index({receiver: 1, readOn: 1});
    NotificationSchema.index({receiver: 1, company: 1});
    NotificationSchema.index({receiver: 1, company: 1, date: -1});
    NotificationSchema.index({receiver: 1, importance: 1});
    NotificationSchema.index({receiver: 1, status: 1});
    NotificationSchema.index({receiver: 1, code: 1});
    NotificationSchema.index({receiver: 1, readOn: 1, date: -1});
    NotificationSchema.index({receiver: 1, company: 1, readOn: 1});
    NotificationSchema.index({company: 1, date: -1});
    NotificationSchema.index({company: 1, importance: 1});
    NotificationSchema.index({company: 1, status: 1});
    NotificationSchema.index({sender: 1, date: -1});
    NotificationSchema.index({sender: 1, company: 1});
    NotificationSchema.index({importance: 1, date: -1});
    NotificationSchema.index({status: 1, date: -1});
    NotificationSchema.index({importance: 1, status: 1});
    NotificationSchema.index({receiver: 1, company: 1, importance: 1, date: -1});
    NotificationSchema.index({receiver: 1, readOn: 1, importance: 1});
    NotificationSchema.index({receiver: 1, category: 1, date: -1});
}
