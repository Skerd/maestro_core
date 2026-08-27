import type {ApiSelectDatum} from "armonia/src/modules/core/types/shared.types";
import type {IRole} from "@coreModule/database/schemas/role/role";

export function roleToSelect(role: IRole): ApiSelectDatum {
    return {
        value: role._id.toString(),
        label: role.name,
    };
}

export function rolesToSelect(roles: IRole[]): ApiSelectDatum[] {
    return roles.map(roleToSelect);
}
