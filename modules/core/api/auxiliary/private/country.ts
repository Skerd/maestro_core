import {createCrudRouter} from "@coreModule/api/crudRouterFactory";
import {countryService} from "@coreModule/database/schemas/country/country.service";
import Country from "@coreModule/database/schemas/country/country";
import {countriesToDTO, countryToDTO} from "@coreModule/utilities/mappers/country/countryMapper.dto";
import {countriesToSelect} from "@coreModule/utilities/mappers/country/countryMapper.select";
import {createCountryFormSchema} from "armonia/src/modules/core/api/auxiliary/private/country/createCountry.form.validator";
import {editCountryFormSchema} from "armonia/src/modules/core/api/auxiliary/private/country/editCountry.form.validator";

export const basePath = "/api/auxiliary/country";

export const {router} = createCrudRouter({
    collectionName: "countries",
    model:          Country,
    service:        countryService,
    createSchema:   createCountryFormSchema,
    editSchema:     editCountryFormSchema,
    toDTO:          countryToDTO,
    toDTOArray:     countriesToDTO,
    toSelect:       countriesToSelect,
    buildCreateData: ({name, code, phoneCode}) => ({
        name,
        code:      code.toUpperCase(),
        phoneCode,
    }),
    buildUpdateData: ({name, code, phoneCode}, w) => ({
        ...(name      !== undefined && w.name      && {name}),
        ...(code      !== undefined && w.code      && {code: code.toUpperCase()}),
        ...(phoneCode !== undefined && w.phoneCode && {phoneCode}),
    }),
});
