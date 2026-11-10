import {describe, expect, it, vi} from "vitest";

const {companyId, userId, findCompany} = vi.hoisted(() => ({
    companyId: "6512f0a1b2c3d4e5f6a7b8c9",
    userId: "6512f0a1b2c3d4e5f6a7b8ca",
    findCompany: vi.fn(),
}));

vi.mock("@coreModule/utilities/security/jwtValidator", () => ({
    validateJWTToken: () => ({id: userId, username: "ada@example.com", company: {_id: companyId}}),
}));
vi.mock("@coreModule/utilities/security/sessionValidator", () => ({validateActiveUserSession: async () => undefined}));
vi.mock("@coreModule/database/schemas/user/user.service", () => ({
    userService: {
        findByIdOrThrow: async () => ({
            _id: userId,
            getCompanyAccess: async () => ({isAdmin: true, permissions: []}),
            checkAccountAccessibility: async () => undefined,
            hasAtLeastOneRole: async () => true,
        }),
    },
}));
vi.mock("@coreModule/database/schemas/company/company.service", () => ({companyService: {findByIdOrThrow: findCompany}}));
vi.mock("@coreModule/environment", async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    SERVER: {TIMEZONE: "Europe/Tirane"},
}));

import authMW from "../authMW";

/** Runs authMW("private") on a signed-in request whose company stores `timezone`; returns the body it wrote. */
async function authenticate(timezone: string | undefined, clientBody: Record<string, unknown> = {}) {
    findCompany.mockResolvedValueOnce({_id: companyId, name: "Lakeside", isActive: true, modules: ["core"], timezone});
    const headers: Record<string, string> = {"x-auth-token": "token"};
    const req = {
        body: clientBody,
        originalUrl: "/api/x",
        socket: {remoteAddress: "127.0.0.1"},
        headers: {},
        header: (name: string) => headers[name],
        get: () => undefined,
    };
    const next = vi.fn();
    await authMW("private")(req, {}, next);
    expect(next).toHaveBeenCalledWith();
    return req.body;
}

describe("authMW company zone (D116)", () => {
    it("loads the company's timezone and writes it as the companyTimeZone server key", async () => {
        const body = await authenticate("Europe/Zurich");

        expect(findCompany.mock.calls.at(-1)![3]).toContain("timezone");
        expect(body.companyTimeZone).toBe("Europe/Zurich");
    });

    it("falls back to the instance zone when the company has none or an unknown one", async () => {
        expect((await authenticate(undefined)).companyTimeZone).toBe("Europe/Tirane");
        expect((await authenticate("Europe/Atlantis")).companyTimeZone).toBe("Europe/Tirane");
    });
});
