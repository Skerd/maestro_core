import {ObjectId} from "mongodb";
import {z} from "zod";
import {createCrudRouter} from "@coreModule/api/crudRouterFactory";
import SchemaGuard from "@coreModule/database/security/schemaGuard";
import {userSessionService} from "@coreModule/database/schemas/userSession/userSession.service";
import UserSession from "@coreModule/database/schemas/userSession/userSession";
import {UserSessionActions} from "@coreModule/database/schemas/userSession/userSession.actions";
import {userSessionsToDTO, userSessionToDTO} from "@coreModule/utilities/mappers/userSession/userSessionMapper.dto";
import {userSessionsToSelect} from "@coreModule/utilities/mappers/userSession/userSessionMapper.select";
import {userSessionFormSchema} from "armonia/src/modules/core/api/user/private/userSession/userSession.form.validator";
import {userSessionsSelectFormSchema} from "armonia/src/modules/core/api/user/private/userSession/userSessions.select.form.validator";
import {getTokenSessionId} from "@coreModule/utilities/security/sessionValidator";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";

export const basePath = "/api/user/userSession";

function userSessionExtraFilter(params: Record<string, any>) {
    const {userId, isActive} = params;
    const filter: Record<string, unknown> = {};
    if (userId) filter.user = new ObjectId(userId);
    if (isActive !== undefined) filter.isActive = isActive;
    return filter;
}

// User sessions are system-managed; revoke uses @action routes on UserSessionActions.
export const {router} = createCrudRouter({
    collectionName: "usersessions",
    model: UserSession,
    service: userSessionService,
    entityName: "User session",
    createSchema: () => z.object({}).passthrough() as any,
    editSchema: () => z.object({_id: z.string()}).passthrough() as any,
    listSchema: userSessionFormSchema,
    selectSchema: userSessionsSelectFormSchema,
    toDTO: userSessionToDTO,
    toDTOArray: userSessionsToDTO,
    toSelect: userSessionsToSelect,
    buildCreateData: () => ({}),
    buildUpdateData: () => ({}),
    actions: UserSessionActions,
    defaultSort: {lastActiveAt: -1},
    extraListFilter: userSessionExtraFilter,
    extraSelectFilter: userSessionExtraFilter,
    beforeDelete: async (params, _doc) => {
        const {languageCode, user, _id} = params;
        if (getTokenSessionId(user) === _id) {
            throw apiValidationException("current_session_cannot_be_deleted", "sessionId", null, languageCode);
        }
    },
    overrideSelectHandler: async (params) => {
        const {logger, languageCode, actionUserCtx, name, page, limit, company, userId, isActive} = params;

        logger.start("Fetching user sessions for select...");

        SchemaGuard.sanitizeFields(UserSession, {sessionId: {}}, "read", actionUserCtx, languageCode);

        const filter: Record<string, unknown> = {
            company: company._id,
            ...userSessionExtraFilter({userId, isActive}),
        };
        if (name !== undefined && name !== "") {
            filter.sessionId = {$regex: String(name).trim(), $options: "i"};
        }

        const [rows, total] = await Promise.all([
            userSessionService.find(
                filter,
                {logger, languageCode},
                undefined,
                "_id sessionId deviceId",
                {lastActiveAt: -1},
                limit,
                (page - 1) * limit,
            ),
            userSessionService.count(filter, {logger, languageCode}),
        ]);

        logger.finish("Finished fetching user sessions for select!");
        return {data: userSessionsToSelect(rows as any), total};
    },
});
