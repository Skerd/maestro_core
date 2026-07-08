/**
 * Notification Service
 *
 * CRUD service for Notification model.
 */

import {BaseCrudService} from "@coreModule/database/services/baseCrudService";
import Notification, {INotification} from "./notification";

export class NotificationService extends BaseCrudService<INotification, typeof Notification> {
    constructor() {
        super(Notification, "Notification");
    }
}

export const notificationService = new NotificationService();
