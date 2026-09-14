import {ObjectId} from "mongodb";
import {createCrudRouter} from "@coreModule/api/crudRouterFactory";
import {cityService} from "@coreModule/database/schemas/city/city.service";
import {countryService} from "@coreModule/database/schemas/country/country.service";
import {stateService} from "@coreModule/database/schemas/state/state.service";
import City, {type ICity} from "@coreModule/database/schemas/city/city";
import {citiesToDTO, cityToDTO} from "@coreModule/utilities/mappers/city/cityMapper.dto";
import {citiesToSelect} from "@coreModule/utilities/mappers/city/cityMapper.select";
import {createCityFormSchema} from "armonia/src/modules/core/api/auxiliary/private/city/createCity.form.validator";
import {editCityFormSchema} from "armonia/src/modules/core/api/auxiliary/private/city/editCity.form.validator";
import type {
    CreateCityFormType,
    EditCityFormType,
} from "armonia/src/modules/core/api/auxiliary/private/city/city.schema-def";

export const basePath = "/api/auxiliary/city";

export const {router} = createCrudRouter<ICity, CreateCityFormType, EditCityFormType>({
    collectionName:  "cities",
    model:           City,
    service:         cityService,
    createSchema:    createCityFormSchema,
    editSchema:      editCityFormSchema,
    toDTO:           cityToDTO,
    toDTOArray:      citiesToDTO,
    toSelect:        citiesToSelect,
    buildCreateData: async ({name, country, state, company, session, logger, languageCode}) => {
        const resolvedCountry = await countryService.findOneOrThrow(
            {_id: new ObjectId(country), company: company._id},
            {session, logger, languageCode},
        );
        let resolvedState = undefined;
        if (state) {
            resolvedState = await stateService.findOneOrThrow(
                {_id: new ObjectId(state), company: company._id, country: resolvedCountry._id},
                {session, logger, languageCode},
            );
        }
        return {
            name, 
            country: resolvedCountry, 
            state: resolvedState
        };
    },
    buildUpdateData: async ({name, country, state, company, session, logger, languageCode}, writeFields) => {
        const resolvedCountry = country !== undefined && writeFields.country ? await countryService.findOneOrThrow(
            {
                _id: new ObjectId(country),
                company: company._id
            },
            {session, logger, languageCode},
        ) : undefined;
        let resolvedState: Awaited<ReturnType<typeof stateService.findOneOrThrow>> | null | undefined;
        if (state !== undefined && writeFields.state) {
            if (state === "") {
                resolvedState = null; // factory: null → $unset
            } else {
                resolvedState = await stateService.findOneOrThrow(
                    {
                        _id: new ObjectId(state),
                        company: company._id,
                        ...(resolvedCountry ? {country: resolvedCountry._id} : {}),
                    },
                    {session, logger, languageCode},
                );
            }
        }
        return {
            ...(name !== undefined && writeFields.name && {name}),
            ...(resolvedCountry !== undefined && {country: resolvedCountry}),
            ...(resolvedState !== undefined && {state: resolvedState}),
        };
    },
});
