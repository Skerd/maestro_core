import {ObjectId} from "mongodb";
import {createCrudRouter} from "@coreModule/api/crudRouterFactory";
import {stateService} from "@coreModule/database/schemas/state/state.service";
import {countryService} from "@coreModule/database/schemas/country/country.service";
import State, {type IState} from "@coreModule/database/schemas/state/state";
import {statesToDTO, stateToDTO} from "@coreModule/utilities/mappers/state/stateMapper.dto";
import {statesToSelect} from "@coreModule/utilities/mappers/state/stateMapper.select";
import {createStateFormSchema} from "armonia/src/modules/core/api/auxiliary/private/state/createState.form.validator";
import {editStateFormSchema} from "armonia/src/modules/core/api/auxiliary/private/state/editState.form.validator";
import type {
    CreateStateFormType,
    EditStateFormType,
} from "armonia/src/modules/core/api/auxiliary/private/state/state.schema-def";


export const basePath = "/api/auxiliary/state";

export const {router} = createCrudRouter<IState, CreateStateFormType, EditStateFormType>({
    collectionName:  "states",
    model:           State,
    service:         stateService,
    createSchema:    createStateFormSchema,
    editSchema:      editStateFormSchema,
    toDTO:           stateToDTO,
    toDTOArray:      statesToDTO,
    toSelect:        statesToSelect,
    buildCreateData: async ({name, code, country, company, session, logger, languageCode}) => ({
        name,
        code,
        country: await countryService.findOneOrThrow(
            {
                _id: new ObjectId(country),
                company: company._id
            },
            {session, logger, languageCode},
        ),
    }),
    buildUpdateData: async ({name, code, country, company, session, logger, languageCode}, writeFields) => {
        const resolvedCountry = country !== undefined && writeFields.country ? await countryService.findOneOrThrow(
            {
                _id: new ObjectId(country), 
                company: company._id
            },
            {session, logger, languageCode},
        ) : undefined;
        return {
            ...(name !== undefined && writeFields.name && {name}),
            ...(code !== undefined && writeFields.code && {code}),
            ...(resolvedCountry !== undefined && {country: resolvedCountry}),
        };
    },
});
