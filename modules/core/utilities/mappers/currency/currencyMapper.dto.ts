import {Currency} from "armonia/src/modules/core/api/finance/private/currency/currency.dto";
import {ICurrency} from "@coreModule/database/schemas/currency/currency";
import {mapOwnershipToDTO, mapSoftDeleteToDTO} from "@coreModule/utilities/mappers/plugin/pluginMappers.dto";

export function currencyToDTO(currency: ICurrency): Currency {
    return {
        _id: currency._id.toString(),
        name: currency.name,
        symbol: currency.symbol,
        decimalPlaces: currency.decimalPlaces,
        abbreviation: currency.abbreviation,
        ...mapSoftDeleteToDTO(currency),
        ...mapOwnershipToDTO(currency),
    };
}

export function currenciesToDTO(currencies: ICurrency[]): Currency[] {
    return currencies.map(currencyToDTO);
}
