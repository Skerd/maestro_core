import {ObjectId} from "mongodb";
import {ClientSession} from "mongoose";
import {userSessionService} from "@coreModule/database/schemas/userSession/userSession.service";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {JWTTokenType} from "armonia/src/modules/core/api/user/public/login/login.form.response.type";
import {IUserSession} from "@coreModule/database/schemas/userSession/userSession";
import {CONSTANTS} from "@coreModule/environment";

type SessionToken = JWTTokenType & {
    sessionId?: string;
    session_id?: string;
};

export function getTokenSessionId(userFromToken: JWTTokenType): string | null {
    return (userFromToken as SessionToken).sessionId ?? (userFromToken as SessionToken).session_id ?? null;
}

export async function validateActiveUserSession(
    userFromToken: JWTTokenType,
    userId: ObjectId,
    companyId: ObjectId,
    options: {
        session?: ClientSession;
        languageCode?: string;
    } = {}
): Promise<IUserSession> {
    const languageCode = options.languageCode ?? CONSTANTS.DEFAULT_LANGUAGE ?? "en-US";
    const tokenSessionId = getTokenSessionId(userFromToken);

    if (!tokenSessionId || tokenSessionId.length !== 24) {
        throw apiValidationException("session_not_found", "sessionId", null, languageCode);
    }

    return userSessionService.findOne(
        {
            _id: new ObjectId(tokenSessionId),
            user: userId,
            company: companyId,
            isActive: true,
            expiresAt: {$gt: new Date()},
        },
        {
            session: options.session,
            languageCode,
        }
    ) as Promise<IUserSession>;
}
