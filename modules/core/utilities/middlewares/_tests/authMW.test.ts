import {describe, expect, it, vi} from "vitest";

const {companyId, userId, sellerId, findCompany, findTarget} = vi.hoisted(() => ({
    companyId: "6512f0a1b2c3d4e5f6a7b8c9",
    userId: "6512f0a1b2c3d4e5f6a7b8ca",
    sellerId: "6512f0a1b2c3d4e5f6a7b8cb",
    findCompany: vi.fn(),
    findTarget: vi.fn(),
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
vi.mock("@coreModule/database/schemas/company/company.service", () => ({companyService: {findByIdOrThrow: findCompany, findById: findTarget}}));
vi.mock("@coreModule/environment", async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    SERVER: {TIMEZONE: "Europe/Tirane"},
    PORTAL_ROOT_DOMAIN: "portal.test",
}));
// A fixture module ("widgets"), so the gate is tested without naming a vertical (CORE-01).
vi.mock("@coreModule/utilities/modules/companyModules", () => ({
    effectiveCompanyModules: (company: {modules?: string[]}) => company.modules ?? [],
    isModuleEnabledForCompany: (company: {modules?: string[]}, name: string) => name === "core" || (company.modules ?? []).includes(name),
}));

import authMW, {type AuthMWOptions} from "../authMW";
import {requestContext} from "@coreModule/utilities/endpoints/requestContext";

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

/** Runs authMW("private") for a buyer of a core-only company on a "widgets" route; returns what `next` got. */
async function buyerRequest(origin: string, options: AuthMWOptions, target?: {isActive: boolean; modules: string[]} | null) {
    findCompany.mockResolvedValueOnce({_id: companyId, name: "Platform", isActive: true, modules: ["core"]});
    findTarget.mockReset();
    if (target !== undefined) findTarget.mockResolvedValueOnce(target && {_id: sellerId, ...target});
    const headers: Record<string, string> = {"x-auth-token": "token", Origin: origin};
    const req = {
        body: {order: sellerId},
        params: {},
        originalUrl: "/api/widgets/my",
        socket: {remoteAddress: "127.0.0.1"},
        headers: {},
        header: (name: string) => headers[name],
        get: (name: string) => headers[name],
    };
    const next = vi.fn();
    await requestContext.run({routeModule: "widgets"}, () => authMW("private", options)(req, {}, next));
    return next.mock.calls[0]?.[0];
}

const sellerOf: AuthMWOptions = {portalBuyer: async ({body}) => body.order as string};

describe("authMW portal buyer module gate (D143, TD-B189)", () => {
    it("lets a portal buyer through when the record's company has the module", async () => {
        expect(await buyerRequest("http://portal.test", sellerOf, {isActive: true, modules: ["core", "widgets"]})).toBeUndefined();
        expect(await buyerRequest("http://acme.portal.test", sellerOf, {isActive: true, modules: ["core", "widgets"]})).toBeUndefined();
        expect(findTarget.mock.calls.at(-1)![0].toString()).toBe(sellerId);
    });

    it("refuses when the record's company lacks the module or is inactive", async () => {
        expect((await buyerRequest("http://portal.test", sellerOf, {isActive: true, modules: ["core"]}))?.error_code).toBe("module_not_enabled");
        expect((await buyerRequest("http://portal.test", sellerOf, {isActive: false, modules: ["core", "widgets"]}))?.error_code).toBe("module_not_enabled");
    });

    it("refuses when the route names no company it can find", async () => {
        expect((await buyerRequest("http://portal.test", sellerOf, null))?.error_code).toBe("module_not_enabled");
        expect((await buyerRequest("http://portal.test", {portalBuyer: async () => "not-an-id"}))?.error_code).toBe("module_not_enabled");
    });

    it("keeps the session company's gate outside the portal zone and on routes that are not buyer routes", async () => {
        expect((await buyerRequest("http://panel.example.com", sellerOf))?.error_code).toBe("module_not_enabled");
        expect((await buyerRequest("http://portal.test", {}))?.error_code).toBe("module_not_enabled");
        expect(findTarget).not.toHaveBeenCalled();
    });
});

describe("authMW and the platform's suspension (D191)", () => {
    it("refuses every request in a company the platform suspended, its admins' too", async () => {
        findCompany.mockResolvedValueOnce({_id: companyId, name: "Lakeside", isActive: true, modules: ["core"], suspendedAt: new Date()});
        const headers: Record<string, string> = {"x-auth-token": "token"};
        const req = {body: {}, originalUrl: "/api/x", socket: {remoteAddress: "127.0.0.1"}, headers: {}, header: (name: string) => headers[name], get: () => undefined};
        const next = vi.fn();
        await authMW("private")(req, {}, next);
        expect(findCompany.mock.calls.at(-1)![3]).toContain("suspendedAt");
        expect(next.mock.calls[0]?.[0]).toMatchObject({error_code: "company_suspended"});
    });
});

describe("authMW and the platform's lists of other modules (D195)", () => {
    /** A signed-in request to a "widgets" route, from a company with core only; returns what authMW passed on. */
    async function listRequest(company: {isPlatformOwner?: boolean}, platformRoute: boolean) {
        findCompany.mockResolvedValueOnce({_id: companyId, name: "Kudoo", isActive: true, modules: ["core"], ...company});
        const headers: Record<string, string> = {"x-auth-token": "token"};
        const req = {
            body: {},
            params: {},
            originalUrl: "/api/widgets/category",
            socket: {remoteAddress: "127.0.0.1"},
            headers: {},
            header: (name: string) => headers[name],
            get: () => undefined,
        };
        const next = vi.fn();
        await requestContext.run({routeModule: "widgets", platformRoute}, () => authMW("private")(req, {}, next));
        return next.mock.calls[0]?.[0];
    }

    it("lets the platform company use a platform list of a module it does not run", async () => {
        expect(await listRequest({isPlatformOwner: true}, true)).toBeUndefined();
    });

    it("keeps the module gate on the module's other routes, and for every other company", async () => {
        expect((await listRequest({isPlatformOwner: true}, false))?.error_code).toBe("module_not_enabled");
        expect((await listRequest({isPlatformOwner: false}, true))?.error_code).toBe("module_not_enabled");
    });
});
