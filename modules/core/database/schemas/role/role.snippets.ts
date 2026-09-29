import type {RoleSimple} from "armonia/src/modules/core/dto/role.dto";
import type {IRole} from "@coreModule/database/schemas/role/role";
import {defineSnippet} from "@coreModule/database/utilities/snippet";

export const RoleSimpleSnippet = defineSnippet<IRole, RoleSimple>()({
    keys: {
        _id: {},
        name: {},
    },
});
