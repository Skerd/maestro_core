import {SimpleUserSnippet} from "@coreModule/database/schemas/user/user.snippets";
import type {ReplyToMessage} from "armonia/src/modules/core/dto/message.dto";
import type {IMessage} from "@coreModule/database/schemas/message/message";
import {defineSnippet} from "@coreModule/database/utilities/snippet";

export const ReplyToMessageSnippet = defineSnippet<IMessage, ReplyToMessage>()({
    keys: {
        _id: {},
        status: {},
        text: {},
        sender: SimpleUserSnippet,
        createdAt: {},
    },
});
