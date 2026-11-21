import {describe, expect, it, vi} from "vitest";

const {sessionCompanyId, memberId, otherMemberId, strangerId, userId, findCompany, findTarget, access, locked} = vi.hoisted(() => ({
    sessionCompanyId: "6512f0a1b2c3d4e5f6a7b8c9",
    memberId: "6512f0a1b2c3d4e5f6a7b8d1",
    otherMemberId: "6512f0a1b2c3d4e5f6a7b8d2",
    strangerId: "6512f0a1b2c3d4e5f6a7b8d3",
    userId: "6512f0a1b2c3d4e5f6a7b8ca",
    findCompany: vi.fn(),
    findTarget: vi.fn(),
    /** The user's access per company id, as their roles there give it. */
    access: new Map<string, {isAdmin: boolean; permissions: string[]}>(),
    locked: new Set<string>(),
}));

vi.mock("@coreModule/utilities/security/jwtValidator", () => ({
    validateJWTToken: () => ({id: userId, username: "ada@example.com", company: {_id: sessionCompanyId}}),
}));
vi.mock("@coreModule/utilities/security/sessionValidator", () => ({validateActiveUserSession: async () => undefined}));
vi.mock("@coreModule/database/schemas/user/user.service", async () => {
    const {ObjectId} = await import("mongodb");
    return {
        userService: {
            findByIdOrThrow: async () => ({
                _id: userId,
                roles: [sessionCompanyId, memberId, otherMemberId].map((company) => ({company: new ObjectId(company)})),
                getCompanyAccess: async (companyId: unknown) => access.get(String(companyId)) ?? {isAdmin: false, permissions: []},
                // The panel's own membership checks: a member, active and not locked out.
                checkAccountAccessibility: async (companyId: unknown) => {
                    if (![sessionCompanyId, memberId, otherMemberId].includes(String(companyId))) throw {error_code: "company_role_not_found"};
                    if (locked.has(String(companyId))) throw {error_code: "user_locked_out"};
                },
                hasAtLeastOneRole: async () => true,
            }),
        },
    };
});
vi.mock("@coreModule/database/schemas/company/company.service", () => ({companyService: {findByIdOrThrow: findCompany, findById: findTarget}}));
vi.mock("@coreModule/environment", async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    SERVER: {TIMEZONE: "Europe/Tirane"},
    PORTAL_ROOT_DOMAIN: "portal.test",
}));
// A fixture module ("widgets"), so the seam is tested without naming a vertical (CORE-01).
vi.mock("@coreModule/utilities/modules/companyModules", () => ({
    effectiveCompanyModules: (company: {modules?: string[]}) => company.modules ?? [],
    isModuleEnabledForCompany: (company: {modules?: string[]}, name: string) => name === "core" || (company.modules ?? []).includes(name),
}));

import mongoose, {Schema} from "mongoose";
import authMW, {type AuthMWOptions} from "../../middlewares/authMW";
import {requestContext} from "@coreModule/utilities/endpoints/requestContext";
import {actionPermissionTag} from "../actionPermissions";
import {memberCompaniesFor} from "../memberCompany";

const Widget = mongoose.model("MemberCompanyWidget", new Schema({title: String}));
const QUOTE = {model: Widget, method: "quote"};
const QUOTE_TAG = actionPermissionTag(Widget, "quote", "self") ?? "";
const quoting: AuthMWOptions = {memberCompany: QUOTE};
const company = (_id: string, fields: {isActive?: boolean; modules?: string[]} = {}) =>
    ({_id: new mongoose.Types.ObjectId(_id), name: _id, isActive: fields.isActive ?? true, modules: fields.modules ?? ["core", "widgets"], timezone: "Europe/Tirane"});

/** The body authMW writes for a signed-in request, as far as these tests read it. */
type AuthedBody = {actAs?: string; company?: {_id: unknown}; actionUserCtx?: {orgId: string; permissions: string[]}};

/** Runs authMW("private") for a portal account (platform company, core only) on a "widgets" route. */
async function request(origin: string, body: AuthedBody, options: AuthMWOptions, target?: ReturnType<typeof company> | null) {
    findCompany.mockResolvedValueOnce(company(sessionCompanyId, {modules: ["core"]}));
    findTarget.mockReset();
    if (target !== undefined) findTarget.mockResolvedValueOnce(target);
    const headers: Record<string, string> = {"x-auth-token": "token", Origin: origin};
    const req = {
        body,
        params: {},
        originalUrl: "/api/widgets/quote",
        socket: {remoteAddress: "127.0.0.1"},
        headers: {},
        header: (name: string) => headers[name],
        get: (name: string) => headers[name],
    };
    let tenant: string | undefined;
    let error: {error_code?: string} | undefined;
    const next = vi.fn((failure?: {error_code?: string}) => {
        error = failure;
        tenant = requestContext.getStore()?.tenantCompanyId;
    });
    await requestContext.run({routeModule: "widgets"}, () => authMW("private", options)(req, {}, next));
    return {error, body: req.body, tenant};
}

describe("a portal session acting for a member company (D172)", () => {
    it("runs the action as that company, with the user's access there, from the portal zone only", async () => {
        access.set(memberId, {isAdmin: false, permissions: [QUOTE_TAG]});
        const {error, body, tenant} = await request("http://portal.test", {actAs: memberId}, quoting, company(memberId));
        expect(error).toBeUndefined();
        expect([String(body.company?._id), body.actionUserCtx?.orgId, tenant]).toEqual([memberId, memberId, memberId]);
        expect(body.actionUserCtx?.permissions).toEqual([QUOTE_TAG]);
        expect((await request("http://tasks.portal.test", {actAs: memberId}, quoting, company(memberId))).error).toBeUndefined();
    });

    it("refuses a company the user does not belong to, a locked-out membership, an inactive company or one without the module", async () => {
        access.set(memberId, {isAdmin: false, permissions: [QUOTE_TAG]});
        expect((await request("http://portal.test", {actAs: strangerId}, quoting, company(strangerId))).error?.error_code).toBe("company_role_not_found");
        expect((await request("http://portal.test", {actAs: "not-an-id"}, quoting)).error?.error_code).toBe("company_role_not_found");
        expect((await request("http://portal.test", {actAs: memberId}, quoting, null)).error?.error_code).toBe("company_role_not_found");
        locked.add(memberId);
        expect((await request("http://portal.test", {actAs: memberId}, quoting, company(memberId))).error?.error_code).toBe("user_locked_out");
        locked.clear();
        expect((await request("http://portal.test", {actAs: memberId}, quoting, company(memberId, {isActive: false}))).error?.error_code).toBe("company_is_inactive");
        expect((await request("http://portal.test", {actAs: memberId}, quoting, company(memberId, {modules: ["core"]}))).error?.error_code).toBe("module_not_enabled");
    });

    it("refuses when the user's role there does not grant the action", async () => {
        access.set(memberId, {isAdmin: false, permissions: ["widgets[read:self]"]});
        expect((await request("http://portal.test", {actAs: memberId}, quoting, company(memberId))).error?.error_code).toBe("user_permissions_not_sufficient");
    });

    it("keeps the session's own company without actAs, outside the portal zone, and on routes that do not allow it", async () => {
        access.set(memberId, {isAdmin: false, permissions: [QUOTE_TAG]});
        expect((await request("http://portal.test", {}, quoting)).error?.error_code).toBe("module_not_enabled");
        expect((await request("http://panel.example.com", {actAs: memberId}, quoting)).error?.error_code).toBe("module_not_enabled");
        expect((await request("http://portal.test", {actAs: memberId}, {})).error?.error_code).toBe("module_not_enabled");
        expect(findTarget).not.toHaveBeenCalled();
    });

    it("lists only the companies the user may act for, without the session's own", async () => {
        access.set(memberId, {isAdmin: false, permissions: [QUOTE_TAG]});
        access.set(otherMemberId, {isAdmin: false, permissions: []});
        findTarget.mockReset();
        findTarget.mockImplementation(async (id: unknown) => company(String(id)));
        const {userService} = await import("@coreModule/database/schemas/user/user.service");
        const user = await userService.findByIdOrThrow(new mongoose.Types.ObjectId(userId));
        const allowed = await memberCompaniesFor(user, new mongoose.Types.ObjectId(sessionCompanyId), QUOTE, "widgets", "en-US");
        expect(allowed.map((row) => String(row._id))).toEqual([memberId]);
    });
});
