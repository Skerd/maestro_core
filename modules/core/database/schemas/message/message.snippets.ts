import {SimpleUserSnippet} from "@coreModule/database/schemas/user/user.snippets";

export const ReplyToMessageSnippet = {
    keys: {
        status: {},
        text: {},
        sender: SimpleUserSnippet,
        date: {}
    }
}