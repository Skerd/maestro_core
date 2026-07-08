import {ObjectId} from "mongodb";
import {action} from "@coreModule/api/actionDecorator";
import SchemaGuard from "@coreModule/database/security/schemaGuard";
import {getTokenSessionId} from "@coreModule/utilities/security/sessionValidator";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {validateSingleForm} from "armonia/src/modules/core/utilities/zod/shared.validator";
import UserSession from "@coreModule/database/schemas/userSession/userSession";
import {userSessionService} from "@coreModule/database/schemas/userSession/userSession.service";

export class UserSessionActions {
    @action({
        auth: "private",
        rateLimit: {windowMs: 60000, max: 30},
        transaction: true,
    })
    async currentRevoke(params: Record<string, any>): Promise<{message: string}> {
        const {logger, languageCode, session, user, company, actionUserCtx} = params;
        const tokenSessionId = getTokenSessionId(user);

        logger.start("Revoking current user session...");
        SchemaGuard.sanitizeFields(UserSession, {isActive: {}}, "write", actionUserCtx, languageCode);

        if (!tokenSessionId) {
            throw apiValidationException("session_not_found", "sessionId", null, languageCode);
        }

        const existing = await userSessionService.findOneOrThrow(
            {_id: new ObjectId(tokenSessionId), user: new ObjectId(actionUserCtx.userId), company: company._id},
            {session, logger, languageCode},
        );

        await userSessionService.updateById(
            existing._id,
            {$set: {isActive: false}},
            {session, logger, languageCode, auditUserId: actionUserCtx.userId, returnNew: true},
        );

        logger.finish("Successfully revoked current user session");
        return {message: "Current user session access revoked"};
    }

    @action({
        auth: "private",
        rateLimit: {windowMs: 60000, max: 30},
        transaction: true,
        schema: validateSingleForm,
    })
    async revoke(params: Record<string, any>): Promise<{message: string}> {
        const {logger, languageCode, session, _id, company, actionUserCtx} = params;

        logger.start(`Revoking user session: ${_id}...`);
        SchemaGuard.sanitizeFields(UserSession, {isActive: {}}, "write", actionUserCtx, languageCode);

        const existing = await userSessionService.findOneOrThrow(
            {_id: new ObjectId(_id), company: company._id},
            {session, logger, languageCode},
        );

        await userSessionService.updateById(
            existing._id,
            {$set: {isActive: false}},
            {session, logger, languageCode, auditUserId: actionUserCtx.userId, returnNew: true},
        );

        logger.finish(`Successfully revoked user session: ${_id}`);
        return {message: "User session access revoked"};
    }
}
