import type {ApiSelectDatum} from "armonia/src/modules/core/types/shared.types";
import type {ICurrency} from "@coreModule/database/schemas/currency/currency";

export function currencyToSelect(currency: ICurrency): ApiSelectDatum {
    return {
        value: currency._id.toString(),
        label: currency.name,
    };
}

export function currenciesToSelect(currencies: ICurrency[]): ApiSelectDatum[] {
    return currencies.map(currencyToSelect);
}
