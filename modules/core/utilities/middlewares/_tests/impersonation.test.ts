import {beforeEach, describe, expect, it, vi} from "vitest";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";

const sanitizeFields = vi.fn();
const findOne = vi.fn();

vi.mock("@coreModule/database/security/schemaGuard", () => ({
    default: {sanitizeFields: (...args: unknown[]) => sanitizeFields(...args)},
}));
vi.mock("@coreModule/database/schemas/user/user", () => ({default: {modelName: "User"}}));
vi.mock("@coreModule/database/schemas/user/user.service", () => ({
    userService: {findOne: (...args: unknown[]) => findOne(...args)},
}));
vi.mock("@coreModule/utilities/endpoints/requestContext", () => ({
    requestContext: {run: (_store: unknown, fn: () => unknown) => fn()},
}));

import {
    assertMayImpersonateCompanyUser,
    loadCompanyPeerForImpersonation,
    readSpecificUserHeader,
} from "../impersonation";
import type {UserContext} from "@coreModule/utilities/types/types";

const PEER = "6512f0a1b2c3d4e5f6a7b8c9";
const ACTOR = "6512f0a1b2c3d4e5f6a7b8d0";

function ctx(overrides: Partial<UserContext> = {}): UserContext {
    return {
        userId: ACTOR,
        orgId: "org",
        isAdmin: false,
        permissions: [],
        isSelf: true,
        ...overrides,
    };
}

describe("readSpecificUserHeader", () => {
    it("reads the header and ignores the form body", () => {
        expect(readSpecificUserHeader({header: () => PEER})).toBe(PEER);
        expect(readSpecificUserHeader({header: () => undefined})).toBeUndefined();
        expect(readSpecificUserHeader({header: () => ""})).toBeUndefined();
        expect(readSpecificUserHeader({header: () => "undefined"})).toBeUndefined();
    });
});

describe("assertMayImpersonateCompanyUser", () => {
    beforeEach(() => sanitizeFields.mockReset());

    it("allows admins without SchemaGuard", () => {
        assertMayImpersonateCompanyUser(ctx({isAdmin: true}), "en-US");
        expect(sanitizeFields).not.toHaveBeenCalled();
    });

    it("allows others-write", () => {
        sanitizeFields.mockReturnValue({name: {}});
        assertMayImpersonateCompanyUser(ctx(), "en-US");
        expect(sanitizeFields).toHaveBeenCalledTimes(1);
    });

    it("allows others-read when write is denied", () => {
        sanitizeFields
            .mockImplementationOnce(() => {
                throw apiValidationException("user_permissions_not_sufficient", null, null, "en-US");
            })
            .mockReturnValueOnce({name: {}});
        assertMayImpersonateCompanyUser(ctx(), "en-US");
        expect(sanitizeFields).toHaveBeenCalledTimes(2);
    });

    it("rejects a peer with no others access", () => {
        sanitizeFields
            .mockImplementationOnce(() => {
                throw new Error("no-others-write");
            })
            .mockImplementationOnce(() => {
                throw new Error("no-others-read");
            });
        let denied: unknown;
        try {
            assertMayImpersonateCompanyUser(ctx(), "en-US");
        } catch (error) {
            denied = error;
        }
        expect(denied).toBeInstanceOf(Error);
        expect(sanitizeFields).toHaveBeenCalledTimes(2);
    });
});

describe("loadCompanyPeerForImpersonation", () => {
    const company = {_id: PEER, name: "Acme"};
    const actorToken = {id: ACTOR, username: "actor", company: {_id: PEER, name: "Acme"}};

    beforeEach(() => findOne.mockReset());

    it("no-ops when the header names the actor", async () => {
        const swap = await loadCompanyPeerForImpersonation({
            specificUserId: ACTOR,
            actorToken,
            company: company as never,
            languageCode: "en-US",
        });
        expect(swap).toBeNull();
        expect(findOne).not.toHaveBeenCalled();
    });

    it("rejects a non-ObjectId header", async () => {
        await expect(loadCompanyPeerForImpersonation({
            specificUserId: "not-an-id",
            actorToken,
            company: company as never,
            languageCode: "en-US",
        })).rejects.toThrow();
    });

    it("rejects a user outside the company", async () => {
        findOne.mockResolvedValue(null);
        await expect(loadCompanyPeerForImpersonation({
            specificUserId: PEER,
            actorToken,
            company: company as never,
            languageCode: "en-US",
        })).rejects.toThrow();
    });

    it("returns parentBypass and swapped userInfo for a company peer", async () => {
        const peer = {_id: {toString: () => PEER}, username: "peer"};
        findOne.mockResolvedValue(peer);
        const swap = await loadCompanyPeerForImpersonation({
            specificUserId: PEER,
            actorToken,
            company: company as never,
            languageCode: "en-US",
        });
        expect(swap?.parentBypass).toBe(actorToken);
        expect(swap?.userInfo).toBe(peer);
        expect(swap?.user.username).toBe("peer");
    });
});
