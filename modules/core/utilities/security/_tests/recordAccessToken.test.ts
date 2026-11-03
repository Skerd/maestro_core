import {describe, expect, it, vi} from "vitest";
import jwt from "jsonwebtoken";

vi.mock("@coreModule/environment", () => ({
    AUTHENTICATION: {
        JWT_SECRET: "test-secret",
        JWT_ISSUER: "arpeggio",
        JWT_CLIENT_AUDIENCE: "client",
        JWT_PANEL_AUDIENCE: "panel",
    },
    CONSTANTS: {DEFAULT_LANGUAGE: "en-US"},
}));

import {generateRecordAccessToken, validateRecordAccessToken} from "../recordAccessToken";
import {generateUnsubscribeToken} from "../unsubscribeToken";
import {validateJWTToken} from "../jwtValidator";

const COMPANY = "6512f0a1b2c3d4e5f6a7b8c9";
const RECORD = "6512f0a1b2c3d4e5f6a7b8d0";

describe("record access tokens", () => {
    it("round-trips purpose, company, record and version", () => {
        const token = generateRecordAccessToken({purpose: "appointment", companyId: COMPANY, recordId: RECORD, version: 3});
        expect(validateRecordAccessToken(token, "appointment")).toMatchObject({
            type: "recordAccess",
            purpose: "appointment",
            companyId: COMPANY,
            recordId: RECORD,
            version: 3,
        });
    });

    it("refuses a token minted for another purpose", () => {
        const token = generateRecordAccessToken({purpose: "appointment", companyId: COMPANY, recordId: RECORD, version: 1});
        expect(() => validateRecordAccessToken(token, "rentalReservation")).toThrow();
    });

    it("never authenticates an API call", () => {
        const token = generateRecordAccessToken({purpose: "appointment", companyId: COMPANY, recordId: RECORD, version: 1});
        expect(() => validateJWTToken(token)).toThrow();
    });

    it("refuses session tokens, other typed tokens and forged signatures", () => {
        const session = jwt.sign({_id: "u1", companyId: COMPANY}, "test-secret", {issuer: "arpeggio", audience: "client", expiresIn: "1h"});
        const unsubscribe = generateUnsubscribeToken({companyId: COMPANY, email: "a@b.c"});
        const forged = jwt.sign(
            {type: "recordAccess", purpose: "appointment", companyId: COMPANY, recordId: RECORD, version: 1},
            "other-secret",
            {issuer: "arpeggio", audience: "client", expiresIn: "1h"},
        );
        for (const token of [session, unsubscribe, forged]) {
            expect(() => validateRecordAccessToken(token, "appointment")).toThrow();
        }
    });

    it("refuses a token without a numeric version", () => {
        const token = jwt.sign(
            {type: "recordAccess", purpose: "appointment", companyId: COMPANY, recordId: RECORD},
            "test-secret",
            {issuer: "arpeggio", audience: "client", expiresIn: "1h"},
        );
        expect(() => validateRecordAccessToken(token, "appointment")).toThrow();
    });
});
