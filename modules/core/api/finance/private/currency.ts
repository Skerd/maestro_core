import {createCrudRouter} from "@coreModule/api/crudRouterFactory";
import Currency from "@coreModule/database/schemas/currency/currency";
import {currencyService} from "@coreModule/database/schemas/currency/currency.service";
import {currenciesToDTO, currencyToDTO} from "@coreModule/utilities/mappers/currency/currencyMapper.dto";
import {currenciesToSelect} from "@coreModule/utilities/mappers/currency/currencyMapper.select";
import {createCurrencyFormSchema} from "armonia/src/modules/core/api/finance/private/currency/createCurrency.form.validator";
import {editCurrencyFormSchema} from "armonia/src/modules/core/api/finance/private/currency/editCurrency.form.validator";

export const {router} = createCrudRouter({
    collectionName: "currencies",
    model:          Currency,
    service:        currencyService,
    createSchema:   createCurrencyFormSchema,
    editSchema:     editCurrencyFormSchema,
    toDTO:          currencyToDTO,
    toDTOArray:     currenciesToDTO,
    toSelect:       currenciesToSelect,
    buildCreateData: ({name, symbol, decimalPlaces, abbreviation}) => ({
        name,
        symbol,
        decimalPlaces,
        abbreviation,
    }),
    buildUpdateData: ({name, symbol, decimalPlaces, abbreviation}, w) => ({
        ...(name          !== undefined && w.name          && {name}),
        ...(symbol        !== undefined && w.symbol        && {symbol}),
        ...(decimalPlaces !== undefined && w.decimalPlaces && {decimalPlaces}),
        ...(abbreviation  !== undefined && w.abbreviation  && {abbreviation}),
    }),
});
