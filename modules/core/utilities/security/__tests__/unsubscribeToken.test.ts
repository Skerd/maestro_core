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

import {
    UNSUBSCRIBE_TOKEN_TYPE,
    generateUnsubscribeToken,
    validateUnsubscribeToken,
} from "../unsubscribeToken";
import {validateJWTToken} from "../jwtValidator";

const COMPANY = "6512f0a1b2c3d4e5f6a7b8c9";

function sign(payload: Record<string, unknown>, audience = "client"): string {
    return jwt.sign(payload, "test-secret", {issuer: "arpeggio", audience, expiresIn: "1h"});
}

describe("unsubscribe tokens", () => {
    it("round-trips company, email, campaign and type", () => {
        const token = generateUnsubscribeToken({
            companyId: COMPANY,
            email: "Person@Example.com",
            campaignId: "6512f0a1b2c3d4e5f6a7b8d0",
            campaignType: "offer",
        });
        const decoded = validateUnsubscribeToken(token);

        expect(decoded.type).toBe(UNSUBSCRIBE_TOKEN_TYPE);
        expect(decoded.companyId).toBe(COMPANY);
        // Lowercased at mint time so it matches the MarketingPreference key.
        expect(decoded.email).toBe("person@example.com");
        expect(decoded.campaignType).toBe("offer");
    });

    it("carries no user id", () => {
        // Keyed on email so one shape serves both client users and leads, and
        // so a leaked link grants nothing beyond this address's preferences.
        const token = generateUnsubscribeToken({companyId: COMPANY, email: "a@b.com"});
        const raw = jwt.decode(token) as Record<string, unknown>;
        expect(raw.userId).toBeUndefined();
        expect(raw.id).toBeUndefined();
    });

    it("omits optional campaign claims when not given", () => {
        const decoded = validateUnsubscribeToken(
            generateUnsubscribeToken({companyId: COMPANY, email: "a@b.com"}),
        );
        expect(decoded.campaignId).toBeUndefined();
        expect(decoded.campaignType).toBeUndefined();
    });

    describe("the two-way wall", () => {
        it("an unsubscribe token cannot authenticate the private API", () => {
            const token = generateUnsubscribeToken({companyId: COMPANY, email: "a@b.com"});
            expect(() => validateJWTToken(token)).toThrow();
        });

        it("an access token cannot be replayed against the unsubscribe endpoints", () => {
            const accessToken = sign({id: "user-1", username: "a@b.com", company: {_id: COMPANY}});
            expect(() => validateUnsubscribeToken(accessToken)).toThrow();
        });

        it("a token with a forged type is rejected", () => {
            const forged = sign({type: "something-else", companyId: COMPANY, email: "a@b.com"});
            expect(() => validateUnsubscribeToken(forged)).toThrow();
        });
    });

    describe("rejects malformed tokens", () => {
        it("missing required claims", () => {
            expect(() => validateUnsubscribeToken(sign({type: UNSUBSCRIBE_TOKEN_TYPE}))).toThrow();
            expect(() => validateUnsubscribeToken(sign({type: UNSUBSCRIBE_TOKEN_TYPE, companyId: COMPANY}))).toThrow();
            expect(() => validateUnsubscribeToken(sign({type: UNSUBSCRIBE_TOKEN_TYPE, email: "a@b.com"}))).toThrow();
        });

        it("a different signing secret", () => {
            const foreign = jwt.sign(
                {type: UNSUBSCRIBE_TOKEN_TYPE, companyId: COMPANY, email: "a@b.com"},
                "other-secret",
                {issuer: "arpeggio", audience: "client", expiresIn: "1h"},
            );
            expect(() => validateUnsubscribeToken(foreign)).toThrow();
        });

        it("a wrong issuer", () => {
            const foreign = jwt.sign(
                {type: UNSUBSCRIBE_TOKEN_TYPE, companyId: COMPANY, email: "a@b.com"},
                "test-secret",
                {issuer: "elsewhere", audience: "client", expiresIn: "1h"},
            );
            expect(() => validateUnsubscribeToken(foreign)).toThrow();
        });

        it("an expired token", () => {
            const expired = jwt.sign(
                {type: UNSUBSCRIBE_TOKEN_TYPE, companyId: COMPANY, email: "a@b.com"},
                "test-secret",
                {issuer: "arpeggio", audience: "client", expiresIn: "-1s"},
            );
            expect(() => validateUnsubscribeToken(expired)).toThrow();
        });

        it("garbage", () => {
            expect(() => validateUnsubscribeToken("not-a-token")).toThrow();
            expect(() => validateUnsubscribeToken("")).toThrow();
        });
    });
});
