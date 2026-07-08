import {ObjectId} from "mongodb";
import {createCrudRouter} from "@coreModule/api/crudRouterFactory";
import {cityService} from "@coreModule/database/schemas/city/city.service";
import {countryService} from "@coreModule/database/schemas/country/country.service";
import {stateService} from "@coreModule/database/schemas/state/state.service";
import City from "@coreModule/database/schemas/city/city";
import {citiesToDTO, cityToDTO} from "@coreModule/utilities/mappers/city/cityMapper.dto";
import {citiesToSelect} from "@coreModule/utilities/mappers/city/cityMapper.select";
import {createCityFormSchema} from "armonia/src/modules/core/api/auxiliary/private/city/createCity.form.validator";
import {editCityFormSchema} from "armonia/src/modules/core/api/auxiliary/private/city/editCity.form.validator";
import {cityFormSchema} from "armonia/src/modules/core/api/auxiliary/private/city/city.form.validator";


export const basePath = "/api/auxiliary/city";

export const {router} = createCrudRouter({
    collectionName:  "cities",
    model:           City,
    service:         cityService,
    createSchema:    createCityFormSchema,
    editSchema:      editCityFormSchema,
    listSchema:      cityFormSchema,
    toDTO:           cityToDTO,
    toDTOArray:      citiesToDTO,
    toSelect:        citiesToSelect,
    extraListFilter: ({country, state}) => ({
        ...(country ? {country: new ObjectId(country)} : {}),
        ...(state   ? {state:   new ObjectId(state)}   : {}),
    }),
    buildCreateData: async ({name, country, state, company, session, logger, languageCode}) => {
        const resolvedCountry = await countryService.findOneOrThrow(
            {_id: new ObjectId(country), company: company._id},
            {session, logger, languageCode},
        );
        let resolvedState: any = undefined;
        if (state) {
            resolvedState = await stateService.findOneOrThrow(
                {_id: new ObjectId(state), company: company._id, country: resolvedCountry._id},
                {session, logger, languageCode},
            );
        }
        return {name, country: resolvedCountry, state: resolvedState};
    },
    buildUpdateData: async ({name, country, state, company, session, logger, languageCode}, w) => {
        const update: Record<string, any> = {};
        if (name    !== undefined && w.name)    update.name = name;
        if (country !== undefined && w.country) {
            update.country = await countryService.findOneOrThrow(
                {_id: new ObjectId(country), company: company._id},
                {session, logger, languageCode},
            );
        }
        if (state !== undefined && w.state) {
            if (state === "") {
                update.state = undefined;
            } else {
                const stateFilter: Record<string, any> = {_id: new ObjectId(state), company: company._id};
                if (update.country) stateFilter.country = update.country;
                update.state = await stateService.findOneOrThrow(stateFilter, {session, logger, languageCode});
            }
        }
        return update;
    },
});
