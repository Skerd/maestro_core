import type {ApiSelectDatum} from "armonia/src/modules/core/types/shared.types";
import type {IUserSession} from "@coreModule/database/schemas/userSession/userSession";

export function userSessionToSelect(model: IUserSession): ApiSelectDatum {
    return {
        value: model._id.toString(),
        label: `${model.sessionId} — ${model.deviceId}`,
    };
}

export function userSessionsToSelect(models: IUserSession[]): ApiSelectDatum[] {
    return models.map(userSessionToSelect);
}
