/**
 * Marketing unsubscribe tokens.
 *
 * An unsubscribe link is followed by someone with no account, no session and no
 * company context, from whatever mail client they happen to use. The token is
 * therefore the only credential *and* the only source of identity and tenant.
 *
 * SECURITY — the two-way wall:
 *   - Every unsubscribe token carries `type: "unsubscribe"`. {@link validateJWTToken}
 *     rejects that type outright, so one can never authenticate a private API
 *     call or a WebSocket connection.
 *   - {@link validateUnsubscribeToken} *requires* that type, so a real user's
 *     access token cannot be replayed against the unsubscribe endpoints either.
 *
 * The payload deliberately carries **no user id** — only an email address.
 * `MarketingPreference` is keyed on `{company, email}` precisely so that one
 * token shape serves both client users and leads, and so a link that leaks
 * grants nothing beyond changing marketing preferences for that one address.
 *
 * @module unsubscribeToken
 */

import jwt from "jsonwebtoken";
import {ObjectId} from "mongodb";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {AUTHENTICATION, CONSTANTS} from "@coreModule/environment";

/** Marks a token as an unsubscribe token. Never valid anywhere else. */
export const UNSUBSCRIBE_TOKEN_TYPE = "unsubscribe";

/**
 * Unsubscribe links sit in mailboxes for years, and a dead one is far worse
 * than a long-lived one: it means someone who wants out cannot get out.
 */
export const UNSUBSCRIBE_TOKEN_EXPIRES_IN = "365d";

export interface UnsubscribeTokenPayload {
    type: typeof UNSUBSCRIBE_TOKEN_TYPE;
    /** Tenant whose marketing this opts out of. The only source of tenant. */
    companyId: string;
    /** The address the preference belongs to. Lowercased at mint time. */
    email: string;
    /** The campaign the link was sent in, for the audit trail. */
    campaignId?: string;
    /** Which preference a one-click opt-out should flip. Absent = all of them. */
    campaignType?: string;
}

export function generateUnsubscribeToken(params: {
    companyId: ObjectId | string;
    email: string;
    campaignId?: ObjectId | string;
    campaignType?: string;
    languageCode?: string;
}): string {
    const {companyId, email, campaignId, campaignType, languageCode = CONSTANTS.DEFAULT_LANGUAGE} = params;
    try {
        return jwt.sign(
            {
                type: UNSUBSCRIBE_TOKEN_TYPE,
                companyId: companyId.toString(),
                email: email.trim().toLowerCase(),
                ...(campaignId ? {campaignId: campaignId.toString()} : {}),
                ...(campaignType ? {campaignType} : {}),
            },
            AUTHENTICATION.JWT_SECRET as string,
            {
                issuer: AUTHENTICATION.JWT_ISSUER,
                audience: AUTHENTICATION.JWT_CLIENT_AUDIENCE,
                expiresIn: UNSUBSCRIBE_TOKEN_EXPIRES_IN,
            },
        );
    }
    catch {
        throw apiValidationException("could_not_sign_JWT", null, null, languageCode);
    }
}

/**
 * Validate and decode an unsubscribe token.
 *
 * Rejects anything that is not explicitly an unsubscribe token, so a leaked
 * access token cannot be used to rewrite someone's marketing preferences.
 */
export function validateUnsubscribeToken(
    token: string,
    languageCode: string = CONSTANTS.DEFAULT_LANGUAGE,
): UnsubscribeTokenPayload {
    try {
        const decoded = jwt.verify(token, AUTHENTICATION.JWT_SECRET as string, {
            algorithms: ["HS256"],
            issuer: AUTHENTICATION.JWT_ISSUER,
            audience: AUTHENTICATION.JWT_CLIENT_AUDIENCE,
        }) as Partial<UnsubscribeTokenPayload>;

        if (decoded.type !== UNSUBSCRIBE_TOKEN_TYPE) {
            throw new Error("Not an unsubscribe token");
        }
        if (!decoded.companyId || !decoded.email) {
            throw new Error("Unsubscribe token is missing required claims");
        }

        return decoded as UnsubscribeTokenPayload;
    }
    catch {
        throw apiValidationException("token_verification_failed", null, null, languageCode);
    }
}
