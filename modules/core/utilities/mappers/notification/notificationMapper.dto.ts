import {INotification} from "@coreModule/database/schemas/notification/notification";
import {NotificationType} from "armonia/src/modules/core/api/user/private/notifications/notifications.dto";

export function notificationToDTO(notification: INotification): NotificationType {
    return {
        _id: notification._id.toString(),
        sender: {
            username: notification.sender?.username,
            _id: notification.sender?._id?.toString(),
        },
        receiver: {
            username: notification.receiver?.username,
            _id: notification.receiver?._id.toString(),
        },
        company: {
            name: notification.company?.name,
            _id: notification.company?._id.toString()
        },
        code: notification.code,
        description: notification.description ?? "",
        content: notification.content,
        extraMessages: notification.extraMessages,
        date: notification.date.toString(),
        status: notification.status,
        importance: notification.importance,
        readOn: notification.readOn && (notification.readOn.toString()),
        category: notification.category,
        channels: notification.channels,
        metadata: notification.metadata
    }
}

export function notificationsToDTO(notifications: INotification[]): NotificationType[] {
    return notifications.map((notification) => {
        return notificationToDTO(notification);
    })
}
