import {ObjectId} from "mongodb";
import {action} from "@coreModule/api/actionDecorator";
import {getTokenSessionId} from "@coreModule/utilities/security/sessionValidator";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {validateSingleForm} from "armonia/src/modules/core/utilities/zod/shared.validator";
import {WebSocketMessageCodes} from "armonia/src/modules/core/websocket/types";
import {userSessionService} from "@coreModule/database/schemas/userSession/userSession.service";
import {userService} from "@coreModule/database/schemas/user/user.service";
import {pushWebsocketMessage} from "@coreModule/connections/connectToWebSocketServer";
import type {serverLogger} from "@coreModule/loggers/serverLog";

function notifySessionRevoked(userId: string, sessionId: string, logger: serverLogger) {
    try {
        pushWebsocketMessage({
            code: WebSocketMessageCodes.SESSION_REVOKED,
            payload: {sessionId},
            userIds: [userId],
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.err(`Failed to notify revoked session ${sessionId}: ${message}`);
    }
}

export class UserSessionActions {
    @action({
        auth: "private",
        rateLimit: {windowMs: 60000, max: 30},
        transaction: true,
        // Signing out ends the caller's own current session, for every user (D14).
        selfService: true,
    })
    async currentRevoke(params: Record<string, any>): Promise<{message: string}> {
        const {logger, languageCode, session, user, company, actionUserCtx} = params;
        const tokenSessionId = getTokenSessionId(user);

        logger.start("Revoking current user session...");

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
        notifySessionRevoked(actionUserCtx.userId, existing._id.toString(), logger);

        logger.finish("Successfully revoked current user session");
        return {message: "Current user session access revoked"};
    }

    @action({
        auth: "private",
        rateLimit: {windowMs: 60000, max: 30},
        transaction: true,
        schema: validateSingleForm,
        // Ending one of the caller's own sessions (another device) needs no role (D14, TD-B24); `revoke` is for others'.
        selfService: true,
    })
    async revokeOwn(params: Record<string, any>): Promise<{message: string}> {
        const {logger, languageCode, session, _id, company, actionUserCtx} = params;

        logger.start(`Revoking own user session: ${_id}...`);

        // Owner check from the caller's identity, never the body: another user's session is not found.
        const existing = await userSessionService.findOneOrThrow(
            {_id: new ObjectId(_id), user: new ObjectId(actionUserCtx.userId), company: company._id},
            {session, logger, languageCode},
        );

        await userSessionService.updateById(
            existing._id,
            {$set: {isActive: false}},
            {session, logger, languageCode, auditUserId: actionUserCtx.userId, returnNew: true},
        );
        notifySessionRevoked(actionUserCtx.userId, existing._id.toString(), logger);

        logger.finish(`Successfully revoked own user session: ${_id}`);
        return {message: "User session access revoked"};
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

        const existing = await userSessionService.findOneOrThrow(
            {_id: new ObjectId(_id), company: company._id},
            {session, logger, languageCode},
        );
        const ownerId = String((existing.user as {_id?: unknown})?._id ?? existing.user);
        const owner = await userService.findById(ownerId, {session, languageCode}, undefined, "isBot");
        if (owner?.isBot) {
            throw apiValidationException("bot_user_not_editable", null, null, languageCode);
        }

        await userSessionService.updateById(
            existing._id,
            {$set: {isActive: false}},
            {session, logger, languageCode, auditUserId: actionUserCtx.userId, returnNew: true},
        );
        notifySessionRevoked(ownerId, existing._id.toString(), logger);

        logger.finish(`Successfully revoked user session: ${_id}`);
        return {message: "User session access revoked"};
    }
}
