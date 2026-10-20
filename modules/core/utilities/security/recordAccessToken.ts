/**
 * Record access tokens — the "manage your booking" link a guest receives by email.
 *
 * A guest who booked without an account has no session, so the link itself is the
 * credential for exactly one record: it names the tenant, the record, what kind of
 * record it is (`purpose`) and the record's `version` when the link was minted.
 *
 * SECURITY — same two-way wall as unsubscribe tokens:
 *   - Every token carries `type: "recordAccess"`. {@link validateJWTToken} rejects
 *     any typed token, so one can never authenticate an API or WebSocket call.
 *   - {@link validateRecordAccessToken} requires that type *and* the expected
 *     purpose, so an appointment link cannot open a rental reservation.
 *
 * Revocation: the owning module stores a version number on the record and bumps
 * it whenever it wants every older link dead (reschedule, cancel). The caller
 * compares `version` from the token with the record's current value.
 *
 * @module recordAccessToken
 */

import jwt from "jsonwebtoken";
import {ObjectId} from "mongodb";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {AUTHENTICATION, CONSTANTS} from "@coreModule/environment";

/** Marks a token as a record access token. Never valid anywhere else. */
export const RECORD_ACCESS_TOKEN_TYPE = "recordAccess";

/** Long enough to cover booking, the visit and a later look at the receipt. */
export const RECORD_ACCESS_TOKEN_EXPIRES_IN = "180d";

export interface RecordAccessTokenPayload {
    type: typeof RECORD_ACCESS_TOKEN_TYPE;
    /** Which kind of record this link opens, chosen by the owning module (e.g. "appointment"). */
    purpose: string;
    /** Tenant of the record. The only source of tenant for the request. */
    companyId: string;
    recordId: string;
    /** The record's link version at mint time. */
    version: number;
}

export function generateRecordAccessToken(params: {
    purpose: string;
    companyId: ObjectId | string;
    recordId: ObjectId | string;
    version: number;
    languageCode?: string;
}): string {
    const {purpose, companyId, recordId, version, languageCode = CONSTANTS.DEFAULT_LANGUAGE} = params;
    try {
        return jwt.sign(
            {
                type: RECORD_ACCESS_TOKEN_TYPE,
                purpose,
                companyId: companyId.toString(),
                recordId: recordId.toString(),
                version,
            },
            AUTHENTICATION.JWT_SECRET as string,
            {
                issuer: AUTHENTICATION.JWT_ISSUER,
                audience: AUTHENTICATION.JWT_CLIENT_AUDIENCE,
                expiresIn: RECORD_ACCESS_TOKEN_EXPIRES_IN,
            },
        );
    }
    catch {
        throw apiValidationException("could_not_sign_JWT", null, null, languageCode);
    }
}

/**
 * Validate and decode a record access token for `purpose`. Throws
 * `token_verification_failed` for anything else, including a token minted for
 * another kind of record. The caller still checks `version` against the record.
 */
export function validateRecordAccessToken(
    token: string,
    purpose: string,
    languageCode: string = CONSTANTS.DEFAULT_LANGUAGE,
): RecordAccessTokenPayload {
    try {
        const decoded = jwt.verify(token, AUTHENTICATION.JWT_SECRET as string, {
            algorithms: ["HS256"],
            issuer: AUTHENTICATION.JWT_ISSUER,
            audience: AUTHENTICATION.JWT_CLIENT_AUDIENCE,
        }) as Partial<RecordAccessTokenPayload>;

        if (decoded.type !== RECORD_ACCESS_TOKEN_TYPE || decoded.purpose !== purpose) {
            throw new Error("Not a record access token for this purpose");
        }
        if (!decoded.companyId || !decoded.recordId || typeof decoded.version !== "number") {
            throw new Error("Record access token is missing required claims");
        }

        return decoded as RecordAccessTokenPayload;
    }
    catch {
        throw apiValidationException("token_verification_failed", null, null, languageCode);
    }
}
