/**
 * Public-chat visitor tokens.
 *
 * A website visitor is anonymous: no account, no password, no session. What they
 * get instead is a narrow bearer token that names exactly one visitor user and
 * exactly one chat channel, and grants authority over nothing else.
 *
 * SECURITY — the two-way wall:
 *   - Every visitor token carries `type: "publicChat"`. {@link validateJWTToken}
 *     rejects that type outright, so a visitor token can never authenticate a
 *     private API call or a normal WebSocket connection.
 *   - {@link validateVisitorToken} *requires* that type, so a real user's token
 *     can never be replayed against the public chat endpoints either.
 *
 * The token is deliberately not a session: there is no Session document and no
 * refresh flow. Revocation is by soft-deleting the visitor user or closing the
 * channel, both of which `visitorAuthMW` re-checks on every request.
 *
 * @module visitorToken
 */

import jwt from "jsonwebtoken";
import {ObjectId} from "mongodb";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {AUTHENTICATION, CONSTANTS} from "@coreModule/environment";

/** Marks a token as a public-chat visitor token. Never valid anywhere else. */
export const VISITOR_TOKEN_TYPE = "publicChat";

/** How long a visitor may resume the same conversation from their browser. */
export const VISITOR_TOKEN_EXPIRES_IN = "30d";

export interface VisitorTokenPayload {
    type: typeof VISITOR_TOKEN_TYPE;
    /** The visitor User document id (`isVisitor: true`). */
    visitorId: string;
    /** Tenant the conversation belongs to. */
    companyId: string;
    /** The single channel this token may read and write. */
    channelId: string;
}

/**
 * Mint a visitor token for one visitor/company/channel triple.
 *
 * Signed with the same secret, issuer and client audience as user tokens — the
 * `type` claim is what separates them, and both validators check it.
 */
export function generateVisitorToken(params: {
    visitorId: ObjectId | string;
    companyId: ObjectId | string;
    channelId: ObjectId | string;
    languageCode?: string;
}): string {
    const {visitorId, companyId, channelId, languageCode = CONSTANTS.DEFAULT_LANGUAGE} = params;
    try {
        return jwt.sign(
            {
                type: VISITOR_TOKEN_TYPE,
                visitorId: visitorId.toString(),
                companyId: companyId.toString(),
                channelId: channelId.toString(),
            },
            AUTHENTICATION.JWT_SECRET as string,
            {
                issuer: AUTHENTICATION.JWT_ISSUER,
                audience: AUTHENTICATION.JWT_CLIENT_AUDIENCE,
                expiresIn: VISITOR_TOKEN_EXPIRES_IN,
            },
        );
    }
    catch {
        throw apiValidationException("could_not_sign_JWT", null, null, languageCode);
    }
}

/**
 * Validate and decode a visitor token.
 *
 * Rejects anything that is not explicitly a visitor token, so a leaked user
 * token cannot be used to talk to the public chat API.
 */
export function validateVisitorToken(
    token: string,
    languageCode: string = CONSTANTS.DEFAULT_LANGUAGE,
): VisitorTokenPayload {
    try {
        const decoded = jwt.verify(token, AUTHENTICATION.JWT_SECRET as string, {
            algorithms: ["HS256"],
            issuer: AUTHENTICATION.JWT_ISSUER,
            audience: AUTHENTICATION.JWT_CLIENT_AUDIENCE,
        }) as Partial<VisitorTokenPayload>;

        if (decoded.type !== VISITOR_TOKEN_TYPE) {
            throw new Error("Not a public-chat visitor token");
        }
        if (!decoded.visitorId || !decoded.companyId || !decoded.channelId) {
            throw new Error("Visitor token is missing required claims");
        }

        return decoded as VisitorTokenPayload;
    }
    catch {
        throw apiValidationException("token_verification_failed", null, null, languageCode);
    }
}
