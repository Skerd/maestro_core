/**
 * JWT Token Validation Utility
 * 
 * Validates JWT tokens using the configured secret.
 */

import jwt from "jsonwebtoken";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {JWTTokenType} from "armonia/src/modules/core/api/user/public/login/login.form.response.type";
import {AUTHENTICATION, CONSTANTS} from "@coreModule/environment";

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
        return decoded;
    }
    catch (err) {
        throw apiValidationException("token_verification_failed", null, null, languageCode);
    }
}

