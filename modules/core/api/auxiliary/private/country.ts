import {createCrudRouter} from "@coreModule/api/crudRouterFactory";
import {platformListRouteOptions} from "@coreModule/api/platformListRoute";
import {countryService} from "@coreModule/database/schemas/country/country.service";
import Country, {type ICountry} from "@coreModule/database/schemas/country/country";
import {countriesToDTO, countryToDTO} from "@coreModule/utilities/mappers/country/countryMapper.dto";
import {countriesToSelect} from "@coreModule/utilities/mappers/country/countryMapper.select";
import {createCountryFormSchema} from "armonia/src/modules/core/api/auxiliary/private/country/createCountry.form.validator";
import {editCountryFormSchema} from "armonia/src/modules/core/api/auxiliary/private/country/editCountry.form.validator";
import type {CreateCountryFormType, EditCountryFormType} from "armonia/src/modules/core/api/auxiliary/private/country/country.schema-def";

export const basePath = "/api/auxiliary/country";

export const {router} = createCrudRouter<ICountry, CreateCountryFormType, EditCountryFormType>({
    collectionName: "countries",
    model:          Country,
    service:        countryService,
    createSchema:   createCountryFormSchema,
    editSchema:     editCountryFormSchema,
    toDTO:          countryToDTO,
    toDTOArray:     countriesToDTO,
    toSelect:       countriesToSelect,
    // The code names the country in the reader's language (TD-F122).
    selectProjection: "_id name code",
    // Places are looked up by name (UX-12); without it the list fell back to newest first and read Z→A.
    defaultSort: {name: 1},
    // A platform list (D160): every company reads the same rows, only the platform company writes them; another
    // company's create is a request the platform approves (requestablePlugin).
    ...platformListRouteOptions<ICountry, CreateCountryFormType>({
        model: Country,
        collectionName: "countries",
        toDTO: countryToDTO,
        service: countryService,
        buildCreateData: ({name, code, phoneCode}) => ({
            name,
            code:      code.toUpperCase(),
            phoneCode,
        }),
    }),
    buildUpdateData: ({name, code, phoneCode}, writeFields) => ({
        ...(name      !== undefined && writeFields.name      && {name}),
        ...(code      !== undefined && writeFields.code      && {code: code.toUpperCase()}),
        ...(phoneCode !== undefined && writeFields.phoneCode && {phoneCode}),
    }),
});
