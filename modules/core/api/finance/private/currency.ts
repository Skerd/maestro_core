import {createCrudRouter} from "@coreModule/api/crudRouterFactory";
import {platformListRouteOptions} from "@coreModule/api/platformListRoute";
import Currency, {type ICurrency} from "@coreModule/database/schemas/currency/currency";
import {currencyService} from "@coreModule/database/schemas/currency/currency.service";
import {currenciesToDTO, currencyToDTO} from "@coreModule/utilities/mappers/currency/currencyMapper.dto";
import {currenciesToSelect} from "@coreModule/utilities/mappers/currency/currencyMapper.select";
import {createCurrencyFormSchema} from "armonia/src/modules/core/api/finance/private/currency/createCurrency.form.validator";
import {editCurrencyFormSchema} from "armonia/src/modules/core/api/finance/private/currency/editCurrency.form.validator";
import type {
    CreateCurrencyFormType,
    EditCurrencyFormType,
} from "armonia/src/modules/core/api/finance/private/currency/currency.schema-def";

export const {router} = createCrudRouter<ICurrency, CreateCurrencyFormType, EditCurrencyFormType>({
    collectionName: "currencies",
    model:          Currency,
    service:        currencyService,
    createSchema:   createCurrencyFormSchema,
    editSchema:     editCurrencyFormSchema,
    toDTO:          currencyToDTO,
    toDTOArray:     currenciesToDTO,
    toSelect:       currenciesToSelect,
    // A platform list (D160): every company reads the same rows, only the platform company writes them; another
    // company's create is a request the platform approves (requestablePlugin).
    ...platformListRouteOptions<ICurrency, CreateCurrencyFormType>({
        model: Currency,
        collectionName: "currencies",
        toDTO: currencyToDTO,
        service: currencyService,
        buildCreateData: ({name, symbol, decimalPlaces, abbreviation}) => ({
            name,
            symbol,
            decimalPlaces,
            abbreviation,
        }),
    }),
    buildUpdateData: ({name, symbol, decimalPlaces, abbreviation}, writeFields) => ({
        ...(name          !== undefined && writeFields.name          && {name}),
        ...(symbol        !== undefined && writeFields.symbol        && {symbol}),
        ...(decimalPlaces !== undefined && writeFields.decimalPlaces && {decimalPlaces}),
        ...(abbreviation  !== undefined && writeFields.abbreviation  && {abbreviation}),
    }),
});
