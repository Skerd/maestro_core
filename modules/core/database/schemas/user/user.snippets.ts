import type {SimpleBlankUser, SimpleUser} from "armonia/src/modules/core/dto/user.dto";
import type {IUser} from "@coreModule/database/schemas/user/user";
import {defineSnippet} from "@coreModule/database/utilities/snippet";

export const SimpleUserSnippet = defineSnippet<IUser, SimpleUser>()({
    keys: {
        _id: {},
        name: {},
        surname: {},
        photo: {},
    },
});

export const SimpleBlankUserSnippet = defineSnippet<IUser, SimpleBlankUser>()({
    keys: {
        _id: {},
        name: {},
        surname: {},
    },
});
