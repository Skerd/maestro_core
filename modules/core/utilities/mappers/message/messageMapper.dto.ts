import {IMessage} from "@coreModule/database/schemas/message/message";
import {MessageType} from "armonia/src/modules/core/api/user/private/chats/messages/messages.form.response.type";
import {DecryptString} from "@coreModule/utilities/security/encryption";
import {ObjectId} from "mongodb";
import {mapMedia, mapPopulatedUserWithPhoto} from "@coreModule/utilities/mappers/common.mapper";

/**
 * Helper to convert ObjectId or string to string
 */
function toIdString(id: any): string {
    if (id instanceof ObjectId) {
        return id.toString();
    }
    return String(id);
}

/**
 * Convert a single message document (or lean object) to DTO
 *
 * @param message - Message document or lean object with populated sender and channel
 * @param currentUserId - ID of the current user to determine if they are the sender
 * @returns Message DTO
 */
export async function messageToDTO(message: IMessage | any, currentUserId: string): Promise<MessageType | null> {

    let isDeleted = message.status === "deleted" || !!message.deletedAt;

    // only if user deleted the message twice, is it never shown again
    for( let deletedFor of (message?.deletedFor || []) ){
        if( deletedFor._id.toString() === currentUserId){
            if( !deletedFor.showMessage ){
                // this means the message was deleted twice, never show again
                return null;
            }
            else{
                // this means the message was deleted once, but the message content should not be shown
                isDeleted = true;
            }
        }
    }

    return {
        _id: toIdString(message._id),
        sender: mapPopulatedUserWithPhoto(message.sender),
        receiver: mapPopulatedUserWithPhoto(message.receiver),
        message: isDeleted ? "" : DecryptString(message.text),
        forwardedMessage: (isDeleted || !message.forwardedText) ? "" : DecryptString(message.forwardedText),
        media: !!message.mediaIds ? message.mediaIds?.map((media) => {
            return mapMedia(media);
        }) : undefined,
        status: isDeleted ? "deleted" : message.status,
        type: message.type,
        replyTo: message.replyTo ? {
            _id: message.replyTo._id.toString(),
            message: (message.replyTo.status === "deleted" || !message.replyTo.status) ? "" : DecryptString(message.replyTo.text),
            sender: mapPopulatedUserWithPhoto(message.replyTo.sender),
            date: message.replyTo.createdAt,
            status: message.replyTo.status,
        } : undefined,
        reactions: message.reactions && message.reactions.length > 0 ? message.reactions.map((reaction) => {
            if( reaction == null ){
                return undefined;
            }
            return (
                {
                    _id: reaction._id.toString(),
                    emoji: reaction.emoji ? DecryptString(reaction.emoji) : undefined,
                    date: reaction.date,
                    user: mapPopulatedUserWithPhoto(reaction.user)
                }
            )
        }).filter(Boolean) : undefined,
        pinned: message.pinned ? {
            date: message.pinned.date,
            user: mapPopulatedUserWithPhoto(message.pinned.user)
        } : undefined,
        mentionedUsers: message.mentionedUsers && message.mentionedUsers.length > 0 ? message.mentionedUsers.map(mapPopulatedUserWithPhoto).filter(Boolean) : undefined,
        delivery: message.delivery && message.delivery.length > 0 ? message.delivery.map((delivery) => {
            return (
                {
                    date: delivery.date,
                    readDate: delivery.readDate,
                    user: mapPopulatedUserWithPhoto(delivery.user)
                }
            )
        }).filter(Boolean) : undefined,
        date: message.createdAt,
    };
}

/**
 * Convert an array of message documents (or lean objects) to DTOs
 *
 * @param messages - Array of message documents or lean objects with populated sender and channel
 * @param currentUserId - ID of the current user to determine if they are the sender
 * @returns Array of message DTOs
 */
export async function messagesToDTO(messages: (IMessage | any)[], currentUserId: string): Promise<MessageType[]> {
    let returnThis = [];
    for( let message of messages ){
        returnThis.push( await messageToDTO(message, currentUserId) );
    }
    return returnThis.filter(x => !!x);
}

