import {ObjectId} from "mongodb";
import {ClientSession} from "mongoose";
import {serverLogger} from "@coreModule/loggers/serverLog";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {channelService} from "@coreModule/database/schemas/channel/channel.service";
import {messageService} from "@coreModule/database/schemas/message/message.service";
import {IMessage} from "@coreModule/database/schemas/message/message";
import {IUser} from "@coreModule/database/schemas/user/user";
import {WebSocketMessageCodes} from "armonia/src/modules/core/websocket/types";
import {pushWebsocketMessage} from "@coreModule/domain/websocket/pushWebsocketMessage";

export const MESSAGE_RECEIPT_MAX_BATCH = 800;

export type MessageReceiptKind = "delivered" | "read";

export type ApplyMessageReceiptsParams = {
    readerUserId: ObjectId;
    channelId: string;
    companyId: ObjectId;
    messageIds: string[];
    kind: MessageReceiptKind;
    session?: ClientSession;
    logger: serverLogger;
    languageCode: string;
    auditUserId?: string | ObjectId;
    newPushWebsocketMessage?: Function
};

export type ReceiptNotifyPayload = {
    senderId: string;
    channelId: string;
    messageId: string;
};

function deliveryUserId(entry: {user: ObjectId | IUser}): string {
    const u = entry.user;
    return u instanceof ObjectId ? u.toString() : u._id.toString();
}

/**
 * Updates per-recipient message delivery / read timestamps and notifies affected senders over WebSocket.
 */
export async function applyMessageReceipts(
    params: ApplyMessageReceiptsParams
): Promise<{updatedMessageIds: string[]; notify: ReceiptNotifyPayload[]}> {
    const {
        readerUserId,
        channelId,
        companyId,
        messageIds,
        kind,
        session,
        logger,
        languageCode,
        auditUserId,
        newPushWebsocketMessage
    } = params;

    const uniqueIds = [...new Set(messageIds.map((id) => id?.trim()).filter(Boolean))];
    if (uniqueIds.length === 0) {
        return {updatedMessageIds: [], notify: []};
    }
    if (uniqueIds.length > MESSAGE_RECEIPT_MAX_BATCH) {
        throw apiValidationException(
            "validation_error",
            "messageIds max length exceeded",
            null,
            languageCode
        );
    }

    const chOid = new ObjectId(channelId);

    const selectedChannel = await channelService.findOneOrThrow(
        {
            _id: chOid,
            company: companyId,
            deleted: false,
            $or: [
                {users: readerUserId},
                {
                    isGroup: true,
                    leftUsers: {
                        $elemMatch: {
                            user: readerUserId,
                            showChannel: true
                        }
                    }
                }
            ]
        },
        {session, logger, languageCode},
        [
            {
                path: "leftUsers",
                select: "user time",
                populate: {path: "user", select: "_id"}
            }
        ]
    );

    const readerStr = readerUserId.toString();
    let leftAt: Date | undefined;
    if (selectedChannel.leftUsers && Array.isArray(selectedChannel.leftUsers)) {
        const found = selectedChannel.leftUsers.find((lu: {user: IUser}) =>
            lu.user._id.equals(readerUserId)
        );
        if (found) {
            leftAt = found.time;
        }
    }

    const objectIds = uniqueIds.map((id) => new ObjectId(id));

    const messages = await messageService.find(
        {
            _id: {$in: objectIds},
            channel: chOid,
            status: {$ne: "deleted"}
        },
        {session, logger, languageCode},
        undefined,
        "sender delivery deletedFor createdAt",
        undefined,
        undefined
    );

    const updatedMessageIds: string[] = [];
    const notify: ReceiptNotifyPayload[] = [];
    const now = new Date();

    for (const doc of messages as IMessage[]) {
        const senderIdRaw = doc.sender;
        const senderId =
            senderIdRaw instanceof ObjectId ? senderIdRaw : (senderIdRaw as IUser)._id;

        if (senderId.equals(readerUserId)) {
            continue;
        }

        if (doc.deletedFor && Array.isArray(doc.deletedFor)) {
            let skipForReader = false;
            for (const df of doc.deletedFor) {
                const uid = df.user instanceof ObjectId ? df.user.toString() : (df.user as IUser)._id.toString();
                if (uid === readerStr && df.showMessage === false) {
                    skipForReader = true;
                    break;
                }
            }
            if (skipForReader) {
                continue;
            }
        }

        if (leftAt && doc.createdAt > leftAt) {
            continue;
        }

        if (!Array.isArray(doc.delivery)) {
            doc.delivery = [] as IMessage["delivery"];
        }

        const idx = doc.delivery.findIndex((d) => deliveryUserId(d) === readerStr);

        /** Skip DB/notify when nothing would change (smoother UI, fewer WS events). */
        let shouldPersist = true;

        if (idx === -1) {
            if (kind === "delivered") {
                //@ts-expect-error
                doc.delivery.push({user: readerUserId, date: now} as (typeof doc.delivery)[0]);
            } else {
                //@ts-expect-error
                doc.delivery.push({user: readerUserId, date: now, readDate: now} as (typeof doc.delivery)[0]);
            }
        } else {
            const entry = doc.delivery[idx];
            if (kind === "delivered") {
                if (entry.date) {
                    shouldPersist = false;
                } else {
                    entry.date = now;
                }
            } else {
                if (entry.readDate) {
                    shouldPersist = false;
                } else {
                    if (!entry.date) {
                        entry.date = now;
                    }
                    entry.readDate = now;
                }
            }
        }

        if (!shouldPersist) {
            continue;
        }

        doc.markModified("delivery");
        if (auditUserId) {
            doc.$locals = doc.$locals || {};
            doc.$locals.auditUserId =
                typeof auditUserId === "string" ? new ObjectId(auditUserId) : auditUserId;
        }
        await doc.save({session});

        updatedMessageIds.push(doc._id.toString());
        notify.push({
            senderId: senderId.toString(),
            channelId: chOid.toString(),
            messageId: doc._id.toString()
        });
    }

    for (const n of notify) {
        try {
            const websocketMessage = {
                code: WebSocketMessageCodes.MESSAGE_RECEIPT_UPDATED,
                payload: {
                    channelId: n.channelId,
                    messageId: n.messageId
                },
                userIds: [n.senderId]
            };
            if( newPushWebsocketMessage ){
                newPushWebsocketMessage(websocketMessage);
            }
            else{
                pushWebsocketMessage(websocketMessage);
            }
        } catch (e) {
            logger.debug?.(`Failed to push MESSAGE_RECEIPT_UPDATED: ${e}`);
        }
    }

    return {updatedMessageIds, notify};
}
