import {ObjectId} from "mongodb";
import {z} from "zod";
import {createCrudRouter} from "@coreModule/api/crudRouterFactory";
import SchemaGuard from "@coreModule/database/security/schemaGuard";
import {loginHistoryService} from "@coreModule/database/schemas/loginHistory/loginHistory.service";
import LoginHistory from "@coreModule/database/schemas/loginHistory/loginHistory";
import {
    loginHistoriesToDTO,
    loginHistoryToDTO,
} from "@coreModule/utilities/mappers/loginHistory/loginHistoryMapper.dto";
import {loginHistoriesToSelect} from "@coreModule/utilities/mappers/loginHistory/loginHistoryMapper.select";
import {loginHistoryFormSchema} from "armonia/src/modules/core/api/user/private/loginHistory/loginHistory.form.validator";
import {loginHistoriesSelectFormSchema} from "armonia/src/modules/core/api/user/private/loginHistory/loginHistories.select.form.validator";

export const basePath = "/api/user/loginHistory";

function loginHistoryExtraFilter(params: Record<string, any>) {
    const {userId, status} = params;
    const filter: Record<string, unknown> = {};
    if (userId) filter.user = new ObjectId(userId);
    if (status) filter.status = status;
    return filter;
}

// Login histories are system-generated; no user-facing create/edit.
export const {router} = createCrudRouter({
    collectionName: "loginhistories",
    model: LoginHistory,
    service: loginHistoryService,
    entityName: "Login history",
    createSchema: () => z.object({}).passthrough() as any,
    editSchema: () => z.object({_id: z.string()}).passthrough() as any,
    listSchema: loginHistoryFormSchema,
    selectSchema: loginHistoriesSelectFormSchema,
    toDTO: loginHistoryToDTO,
    toDTOArray: loginHistoriesToDTO,
    toSelect: loginHistoriesToSelect,
    buildCreateData: () => ({}),
    buildUpdateData: () => ({}),
    defaultSort: {time: -1},
    extraListFilter: loginHistoryExtraFilter,
    extraSelectFilter: loginHistoryExtraFilter,
    beforeDelete: async () => {},
    overrideSelectHandler: async (params) => {
        const {logger, languageCode, actionUserCtx, name, page, limit, company, userId, status} = params;

        logger.start("Fetching login histories for select...");

        SchemaGuard.sanitizeFields(LoginHistory, {time: {}}, "read", actionUserCtx, languageCode);

        const filter: Record<string, unknown> = {
            company: company._id,
            ...loginHistoryExtraFilter({userId, status}),
        };
        if (name !== undefined && name !== "") {
            filter.ip = {$regex: String(name).trim(), $options: "i"};
        }

        const [rows, total] = await Promise.all([
            loginHistoryService.find(
                filter,
                {logger, languageCode},
                undefined,
                "_id time status ip",
                {time: -1},
                limit,
                (page - 1) * limit,
            ),
            loginHistoryService.count(filter, {logger, languageCode}),
        ]);

        logger.finish("Finished fetching login histories for select!");
        return {data: loginHistoriesToSelect(rows as any), total};
    },
});
