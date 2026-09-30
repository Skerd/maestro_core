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

import {validateJWTToken} from "../jwtValidator";
import {VISITOR_TOKEN_TYPE} from "../visitorToken";
import {UNSUBSCRIBE_TOKEN_TYPE} from "../unsubscribeToken";

function sign(payload: Record<string, unknown>, audience = "client"): string {
    return jwt.sign(payload, "test-secret", {issuer: "arpeggio", audience, expiresIn: "1h"});
}

describe("validateJWTToken allowlist", () => {
    it("accepts session tokens with no type", () => {
        const token = sign({
            id: "user-1",
            username: "a@b.com",
            company: {_id: "6512f0a1b2c3d4e5f6a7b8c9", name: "Acme"},
        });
        const decoded = validateJWTToken(token);
        expect(decoded.id).toBe("user-1");
    });

    it("rejects refresh, visitor, unsubscribe, and unknown types", () => {
        const company = {_id: "6512f0a1b2c3d4e5f6a7b8c9", name: "Acme"};
        expect(() => validateJWTToken(sign({id: "u", type: "refresh", company}))).toThrow();
        expect(() => validateJWTToken(sign({id: "u", type: VISITOR_TOKEN_TYPE, company}))).toThrow();
        expect(() => validateJWTToken(sign({id: "u", type: UNSUBSCRIBE_TOKEN_TYPE, company}))).toThrow();
        expect(() => validateJWTToken(sign({id: "u", type: "future-purpose", company}))).toThrow();
    });
});
