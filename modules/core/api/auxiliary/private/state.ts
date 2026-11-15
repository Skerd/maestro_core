import {ObjectId} from "mongodb";
import {createCrudRouter} from "@coreModule/api/crudRouterFactory";
import {platformListRouteOptions} from "@coreModule/api/platformListRoute";
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
    // A platform list (D160): every company reads the same rows, only the platform company writes them; another
    // company's create is a request the platform approves (requestablePlugin).
    ...platformListRouteOptions<IState, CreateStateFormType>({
        model: State,
        collectionName: "states",
        toDTO: stateToDTO,
        service: stateService,
        buildCreateData: async ({name, code, country, session, logger, languageCode}) => ({
            name,
            code,
            country: await countryService.findOneOrThrow({_id: new ObjectId(country)}, {session, logger, languageCode}),
        }),
    }),
    buildUpdateData: async ({name, code, country, session, logger, languageCode}, writeFields) => {
        const resolvedCountry = country !== undefined && writeFields.country
            ? await countryService.findOneOrThrow({_id: new ObjectId(country)}, {session, logger, languageCode})
            : undefined;
        return {
            ...(name !== undefined && writeFields.name && {name}),
            ...(code !== undefined && writeFields.code && {code}),
            ...(resolvedCountry !== undefined && {country: resolvedCountry}),
        };
    },
});
