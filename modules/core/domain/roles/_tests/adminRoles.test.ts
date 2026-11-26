import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";
import mongoose from "mongoose";
import {ObjectId} from "mongodb";
import request from "supertest";

const company = new ObjectId();
const otherCompany = new ObjectId();
const {platform} = vi.hoisted(() => ({platform: {on: false}}));

// authMW as it runs in production for these routes: the actor's account and token, and the company's platform flag.
vi.mock("@coreModule/utilities/middlewares/authMW", async () => {
    const {authMWStub} = await import("@coreModule/_tests/httpHarness");
    const {default: UserModel} = await import("@coreModule/database/schemas/user/user");
    return {
        default: (scope?: string) => (req: {body: Record<string, unknown>}, res: unknown, next: () => void) =>
            authMWStub.default(scope)(req, res, async () => {
                const actorId = (req.body.actionUserCtx as {userId: string}).userId;
                const actor = await UserModel.findById(actorId);
                req.body.userInfo = actor;
                req.body.actionUserInfo = actor;
                req.body.company = {...(req.body.company as object), name: "Vista", isPlatformOwner: platform.on};
                req.body.user = {id: actorId, username: actor?.username, company: {_id: company.toString(), name: "Vista"}};
                next();
            }),
    };
});
vi.mock("@coreModule/utilities/middlewares/rateLimiter", () => ({
    rateLimiter: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("@coreModule/utilities/emails/notifiers", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@coreModule/utilities/emails/notifiers")>()),
    sendAddedToCompanyMail: async () => undefined,
}));

import {allPermissionTags, appFor, callerHeader, type TestCaller} from "@coreModule/_tests/httpHarness";
import User from "@coreModule/database/schemas/user/user";
import Role from "@coreModule/database/schemas/role/role";
import * as usersRoute from "@coreModule/api/company/private/users";
import * as permissionsRoute from "@coreModule/api/user/private/permissions";
import * as statusRoute from "@coreModule/api/user/private/status";

const app = appFor([
    {basePath: "/api/company/users", router: usersRoute.router, module: "core"},
    {basePath: "/api/user/permissions", router: permissionsRoute.router, module: "core"},
    {basePath: "/api/user/status", router: statusRoute.router, module: "core"},
]);

const sysAdminRole = new ObjectId();
const generalAdministratorRole = new ObjectId();
const clerkRole = new ObjectId();

const owner = new ObjectId();
const manager = new ObjectId();
const bob = new ObjectId();

const everyUserTag = () => allPermissionTags([User, Role]);
const sysAdmin = (): TestCaller => ({userId: owner.toString(), companyId: company.toString(), isAdmin: true, permissions: everyUserTag(), modules: ["core"]});
// May edit users, but holds no admin role.
const userManager = (): TestCaller => ({userId: manager.toString(), companyId: company.toString(), isAdmin: false, permissions: everyUserTag(), modules: ["core"]});

beforeAll(async () => {
    await connectTestDatabase();
    await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
}, 120000);

afterAll(async () => {
    await disconnectTestDatabase();
});

async function insertMember(_id: ObjectId, username: string, roles: ObjectId[], companyId = company): Promise<void> {
    await User.collection.insertOne({
        _id,
        username,
        name: username.split("@")[0],
        surname: "Test",
        fullName: `${username.split("@")[0]} Test`,
        password: "hashed",
        companies: [companyId],
        roles: [{company: companyId, roles, active: "active", rolesCount: roles.length}],
        isBot: false,
        registerDate: new Date(),
        deletedAt: null,
    });
}

const holds = async (userId: ObjectId, roleId: ObjectId): Promise<boolean> =>
    !!(await User.collection.findOne({_id: userId, roles: {$elemMatch: {company, roles: roleId}}}));

beforeEach(async () => {
    platform.on = false;
    await Promise.all([User.collection.deleteMany({}), Role.collection.deleteMany({})]);
    const role = (_id: ObjectId, name: string, slug: string, isAdmin: boolean) =>
        ({_id, company, name, slug, isAdmin, isSignupDefault: false, canEdit: !isAdmin, canDelete: false, permissions: [], deletedAt: null});
    await Role.collection.insertMany([
        role(sysAdminRole, "SysAdmin", "vista:reserved:sys_admin", true),
        role(generalAdministratorRole, "General Administrator", "vista:reserved:general_administrator", true),
        role(clerkRole, "Clerk", "vista:clerk", false),
    ]);
    await insertMember(owner, "owner@example.com", [sysAdminRole]);
    await insertMember(manager, "manager@example.com", [clerkRole]);
    await insertMember(bob, "bob@example.com", [clerkRole]);
});

const pickerLabels = async (caller: TestCaller): Promise<string[]> => {
    const res = await request(app).post("/api/user/permissions/accessible/roles/select").set(callerHeader(caller)).send({page: 1, limit: 50});
    expect(res.body.error_code ?? "ok").toBe("ok");
    return res.body.data.map((option: {label: string}) => option.label).sort();
};

const invite = (caller: TestCaller, email: string, roleId: ObjectId) =>
    request(app).put("/api/company/users/invite").set(callerHeader(caller))
        .send({email, name: "New", surname: "Member", userRole: roleId.toString()});

const toggleRoles = (caller: TestCaller, target: ObjectId, roleIds: ObjectId[]) =>
    request(app).put("/api/user/permissions/roles").set({...callerHeader(caller), specificUser: target.toString()})
        .send({roles: roleIds.map(String)});

const setStatus = (caller: TestCaller, target: ObjectId, status: boolean) =>
    request(app).put("/api/user/status").set({...callerHeader(caller), specificUser: target.toString()}).send({status});

describe("General Administrator is the company's owner (D194)", {timeout: 30000}, () => {
    it("is offered in the role picker to the SysAdmin only, and never in the platform company", async () => {
        expect(await pickerLabels(sysAdmin())).toEqual(["Clerk", "General Administrator"]);
        expect(await pickerLabels(userManager())).toEqual(["Clerk"]);
        platform.on = true;
        expect(await pickerLabels(sysAdmin())).toEqual(["Clerk"]);
    });

    it("is given by the SysAdmin, to one person at a time", async () => {
        await insertMember(new ObjectId(), "ann@example.com", [new ObjectId()], otherCompany);
        await insertMember(new ObjectId(), "carl@example.com", [new ObjectId()], otherCompany);

        const byManager = await invite(userManager(), "ann@example.com", generalAdministratorRole);
        expect(byManager.body.error_code).toBe("general_administrator_needs_sys_admin");

        const bySysAdmin = await invite(sysAdmin(), "ann@example.com", generalAdministratorRole);
        expect(bySysAdmin.body.error_code ?? "ok").toBe("ok");

        const second = await invite(sysAdmin(), "carl@example.com", generalAdministratorRole);
        expect(second.body.error_code).toBe("general_administrator_already_held");
    });

    it("is never given in the platform company, and SysAdmin is never given by hand", async () => {
        await insertMember(new ObjectId(), "ann@example.com", [new ObjectId()], otherCompany);
        expect((await invite(sysAdmin(), "ann@example.com", sysAdminRole)).body.error_code).toBe("one_of_the_roles_does_not_exist");
        platform.on = true;
        expect((await invite(sysAdmin(), "ann@example.com", generalAdministratorRole)).body.error_code).toBe("general_administrator_not_in_platform");
    });

    it("is given and taken away by toggling a member's roles, by the SysAdmin only", async () => {
        expect((await toggleRoles(userManager(), bob, [generalAdministratorRole])).body.error_code).toBe("general_administrator_needs_sys_admin");

        expect((await toggleRoles(sysAdmin(), bob, [generalAdministratorRole])).body.error_code ?? "ok").toBe("ok");
        expect(await holds(bob, generalAdministratorRole)).toBe(true);

        // Bob is now an administrator: someone who may edit users still cannot change him.
        expect((await toggleRoles(userManager(), bob, [clerkRole])).body.error_code).toBe("administrator_needs_sys_admin");
        expect(await holds(bob, clerkRole)).toBe(true);

        expect((await toggleRoles(sysAdmin(), bob, [generalAdministratorRole])).body.error_code ?? "ok").toBe("ok");
        expect(await holds(bob, generalAdministratorRole)).toBe(false);
    });

    it("keeps the SysAdmin's own role out of reach", async () => {
        await User.collection.updateOne({_id: bob}, {$set: {"roles.0.roles": [generalAdministratorRole]}});
        expect((await toggleRoles(sysAdmin(), bob, [sysAdminRole])).body.error_code).toBe("one_of_the_roles_does_not_exist");
        expect((await toggleRoles(userManager(), owner, [clerkRole])).body.error_code).toBe("administrator_needs_sys_admin");
    });

    it("lets only the SysAdmin deactivate an administrator", async () => {
        await User.collection.updateOne({_id: bob}, {$set: {"roles.0.roles": [generalAdministratorRole]}});
        expect((await setStatus(userManager(), bob, false)).body.error_code).toBe("administrator_needs_sys_admin");
        expect((await setStatus(userManager(), owner, false)).body.error_code).toBe("administrator_needs_sys_admin");

        expect((await setStatus(sysAdmin(), bob, false)).body.error_code ?? "ok").toBe("ok");
        expect((await User.collection.findOne({_id: bob}))?.roles[0].active).toBe("inactive");

        // An ordinary member is still anyone's with the permission to edit users.
        const dan = new ObjectId();
        await insertMember(dan, "dan@example.com", [clerkRole]);
        expect((await setStatus(userManager(), dan, false)).body.error_code ?? "ok").toBe("ok");
    });
});
