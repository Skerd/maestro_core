import {IMessage} from "@coreModule/database/schemas/message/message";
import {DecryptString} from "@coreModule/utilities/security/encryption";
import {
    AddReactionFormResponseType
} from "armonia/src/modules/core/api/user/private/chats/messages/actions/addReaction.form.response.type";
import {mapPopulatedUserWithPhoto} from "@coreModule/utilities/mappers/common.mapper";

type MessageReactionSubdocument = NonNullable<IMessage["reactions"]>[number];

export function messageReactionToDTO(r: MessageReactionSubdocument): AddReactionFormResponseType {
    if( !r ){
        return undefined
    }
    return {
        _id: r._id.toString(),
        emoji: r.emoji ? DecryptString(r.emoji) : undefined,
        date: r.date,
        user: mapPopulatedUserWithPhoto(r.user)
    };
}

export function messageReactionsToDTO(reactions: NonNullable<IMessage["reactions"]> | undefined): AddReactionFormResponseType[] {
    return (reactions ?? []).map((r) => {
        return messageReactionToDTO(r);
    });
}
