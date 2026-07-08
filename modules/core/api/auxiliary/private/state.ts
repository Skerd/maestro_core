import {ObjectId} from "mongodb";
import {createCrudRouter} from "@coreModule/api/crudRouterFactory";
import {stateService} from "@coreModule/database/schemas/state/state.service";
import {countryService} from "@coreModule/database/schemas/country/country.service";
import State from "@coreModule/database/schemas/state/state";
import {statesToDTO, stateToDTO} from "@coreModule/utilities/mappers/state/stateMapper.dto";
import {statesToSelect} from "@coreModule/utilities/mappers/state/stateMapper.select";
import {createStateFormSchema} from "armonia/src/modules/core/api/auxiliary/private/state/createState.form.validator";
import {editStateFormSchema} from "armonia/src/modules/core/api/auxiliary/private/state/editState.form.validator";
import {stateFormSchema} from "armonia/src/modules/core/api/auxiliary/private/state/state.form.validator";


export const basePath = "/api/auxiliary/state";

export const {router} = createCrudRouter({
    collectionName:  "states",
    model:           State,
    service:         stateService,
    createSchema:    createStateFormSchema,
    editSchema:      editStateFormSchema,
    listSchema:      stateFormSchema,
    toDTO:           stateToDTO,
    toDTOArray:      statesToDTO,
    toSelect:        statesToSelect,
    extraListFilter:   ({country}) => country ? {country: new ObjectId(country)} : {},
    buildCreateData: async ({name, code, country, company, session, logger, languageCode}) => ({
        name,
        code,
        country: await countryService.findOneOrThrow(
            {_id: new ObjectId(country), company: company._id},
            {session, logger, languageCode},
        ),
    }),
    buildUpdateData: async ({name, code, country, company, session, logger, languageCode}, w) => {
        const update: Record<string, any> = {};
        if (name    !== undefined && w.name)    update.name = name;
        if (code    !== undefined && w.code)    update.code = code;
        if (country !== undefined && w.country) {
            update.country = await countryService.findOneOrThrow(
                {_id: new ObjectId(country), company: company._id},
                {session, logger, languageCode},
            );
        }
        return update;
    },
});
