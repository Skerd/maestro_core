/**
 * JWT Token Validation Utility
 * 
 * Validates JWT tokens using the configured secret.
 */

import jwt from "jsonwebtoken";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {JWTTokenType} from "armonia/src/modules/core/api/user/public/login/login.form.response.type";
import {AUTHENTICATION, CONSTANTS} from "@coreModule/environment";
import {VISITOR_TOKEN_TYPE} from "@coreModule/utilities/security/visitorToken";
import {UNSUBSCRIBE_TOKEN_TYPE} from "@coreModule/utilities/security/unsubscribeToken";

/**
 * Validate and decode JWT token
 * 
 * @param token - JWT token string
 * @param languageCode - Language code for error messages
 * @returns Decoded token data
 * @throws ActionException if token is invalid
 */
export function validateJWTToken(token: string, languageCode: string = CONSTANTS.DEFAULT_LANGUAGE): JWTTokenType {
    try {
        const audiences = [
            AUTHENTICATION.JWT_CLIENT_AUDIENCE,
            AUTHENTICATION.JWT_PANEL_AUDIENCE,
        ].filter(Boolean) as string[];
        const options: jwt.VerifyOptions = {
            algorithms: ["HS256"],
            issuer: AUTHENTICATION.JWT_ISSUER,
            audience: audiences.length > 0 ? audiences : undefined,
        };
        const decoded = jwt.verify(token, AUTHENTICATION.JWT_SECRET as string, options) as JWTTokenType & {type?: string};
        if (decoded.type === "refresh") {
            throw new Error("Refresh tokens cannot authenticate API or websocket requests");
        }
        // Public-chat visitor tokens are signed with the same secret but grant
        // authority over a single chat channel only. They must never reach the
        // private API or a normal websocket connection.
        if (decoded.type === VISITOR_TOKEN_TYPE) {
            throw new Error("Public-chat visitor tokens cannot authenticate API or websocket requests");
        }
        // Unsubscribe tokens are likewise same-secret but single-purpose: they
        // name an email address and a tenant, nothing more.
        if (decoded.type === UNSUBSCRIBE_TOKEN_TYPE) {
            throw new Error("Unsubscribe tokens cannot authenticate API or websocket requests");
        }
        // NOTE: this list is a denylist, so it is fail-open by construction —
        // a new same-secret token type authenticates here until someone
        // remembers to add it. Any future narrow-purpose token must be added
        // above, and its own validator must require its `type` in return.
        return decoded;
    }
    catch (err) {
        throw apiValidationException("token_verification_failed", null, null, languageCode);
    }
}

