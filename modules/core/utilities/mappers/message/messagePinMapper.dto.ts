import {IMessage} from "@coreModule/database/schemas/message/message";
import {
    GetMessagePinSingleFormResponseType
} from "armonia/src/modules/core/api/user/private/chats/messages/getMessagePinSingle.form.response.type";
import {mapPopulatedUserWithPhoto} from "@coreModule/utilities/mappers/common.mapper";

export function messagePinToDTO(message: IMessage): GetMessagePinSingleFormResponseType {
    if (!message?.pinned) {
        return null;
    }
    return {
        date: message.pinned.date,
        user: mapPopulatedUserWithPhoto(message.pinned.user)
    };
}
