import type {ApiSelectDatum} from "armonia/src/modules/core/types/shared.types";
import type {ILoginHistory} from "@coreModule/database/schemas/loginHistory/loginHistory";

export function loginHistoryToSelect(model: ILoginHistory): ApiSelectDatum {
    const t = model.time instanceof Date ? model.time : new Date(model.time);
    return {
        value: model._id.toString(),
        label: `${model.status} — ${t.toISOString()} — ${model.ip ?? ""}`,
    };
}

export function loginHistoriesToSelect(models: ILoginHistory[]): ApiSelectDatum[] {
    return models.map(loginHistoryToSelect);
}
