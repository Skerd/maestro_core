import type {CurrencySimple} from "armonia/src/modules/core/dto/currency.dto";
import type {ICurrency} from "@coreModule/database/schemas/currency/currency";
import {defineSnippet} from "@coreModule/database/utilities/snippet";

export const CurrencySimpleSnippet = defineSnippet<ICurrency, CurrencySimple>()({
    keys: {
        _id: {},
        name: {},
        symbol: {},
        abbreviation: {},
    },
});
