import {IMessage} from "@coreModule/database/schemas/message/message";
import {
    GetMessagePinSingleFormResponseType
} from "armonia/src/modules/core/api/user/private/chats/messages/getMessagePinSingle.form.response.type";
import type {SimpleUser} from "armonia/src/modules/core/dto/user.dto";
import {SimpleUserSnippet} from "@coreModule/database/schemas/user/user.snippets";
import {mapSnippet} from "@coreModule/utilities/mappers/common.mapper";

export function messagePinToDTO(message: IMessage): GetMessagePinSingleFormResponseType {
    if (!message?.pinned) {
        return null;
    }
    return {
        date: message.pinned.date,
        user: mapSnippet<SimpleUser>()(message.pinned.user, SimpleUserSnippet)
    };
}
