/** TD-B225: the hand-written core user and role pickers label a stored value by its id, past the first page and never another company's. */
import {afterAll, beforeAll, describe, expect, it, vi} from "vitest";
import {Types} from "mongoose";
import request from "supertest";

vi.mock("@coreModule/utilities/middlewares/authMW", async () => (await import("@coreModule/_tests/httpHarness")).authMWStub);
// No Redis in tests; the limiter fails closed without it.
vi.mock("@coreModule/utilities/middlewares/rateLimiter", () => ({
    rateLimiter: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import {allPermissionTags, appFor, callerHeader, type TestCaller} from "@coreModule/_tests/httpHarness";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";
import {router as usersRouter} from "@coreModule/api/company/private/users";
import {router as permissionsRouter} from "@coreModule/api/user/private/permissions";
import User from "@coreModule/database/schemas/user/user";
import Role from "@coreModule/database/schemas/role/role";

const app = appFor([
    {basePath: "/api/company/users", router: usersRouter},
    {basePath: "/api/user/permissions", router: permissionsRouter},
]);

const companyId = new Types.ObjectId();
const otherCompanyId = new Types.ObjectId();
const caller: TestCaller = {userId: new Types.ObjectId().toString(), companyId: companyId.toString(), isAdmin: true, permissions: allPermissionTags([User, Role])};
const post = (path: string, body: Record<string, unknown>) => request(app).post(path).set(callerHeader(caller)).send(body);

const memberOf = (company: Types.ObjectId, fullName: string) => ({
    fullName, name: fullName, surname: "", username: `${fullName.replace(/\s/g, ".").toLowerCase()}@test.local`, companies: [company], roles: [{company, active: "active", roles: []}], deletedAt: null,
});
const roleOf = (company: Types.ObjectId, name: string, extra: Record<string, unknown> = {}) => ({
    name, slug: `test:default:${name.toLowerCase()}`, company, isAdmin: false, isSignupDefault: false, deletedAt: null, ...extra,
});
const insertedIds = (result: {insertedIds: Record<number, Types.ObjectId>}) => Object.values(result.insertedIds).map(String);

beforeAll(async () => {
    await connectTestDatabase();
}, 120000);

afterAll(async () => {
    await disconnectTestDatabase();
});

describe("core users select by ids", {timeout: 60000}, () => {
    it("labels a user past the first page, ignoring the search and the staff narrowing, never another company's", async () => {
        const users = insertedIds(await User.collection.insertMany(["Ada Alpha", "Ben Bravo", "Cleo Charlie"].map((name) => memberOf(companyId, name))));
        const foreign = (await User.collection.insertOne(memberOf(otherCompanyId, "Fay Foreign"))).insertedId.toString();

        const firstPage = await post("/api/company/users/select", {page: 1, limit: 1});
        expect(firstPage.status).toBe(200);
        expect(firstPage.body.data.map((o: {label: string}) => o.label)).toEqual(["Ada Alpha"]);

        const byId = await post("/api/company/users/select", {page: 1, limit: 1, name: "Ada", administration: true, ids: [users[2], foreign]});
        expect(byId.status).toBe(200);
        expect(byId.body.data.map((o: {value: string; label: string}) => [o.value, o.label])).toEqual([[users[2], "Cleo Charlie"]]);
        expect(byId.body.total).toBe(1);
    });

    it("labels former staff (an inactive membership) by id, while the search list offers active members only (D157)", async () => {
        const former = {...memberOf(companyId, "Dora Departed"), roles: [{company: companyId, active: "inactive", roles: []}]};
        // Active in another company, inactive here: still former staff of this one.
        const movedOn = {
            ...memberOf(companyId, "Dan Departed"), companies: [companyId, otherCompanyId],
            roles: [{company: otherCompanyId, active: "active", roles: []}, {company: companyId, active: "inactive", roles: []}],
        };
        const [formerId, movedOnId] = insertedIds(await User.collection.insertMany([former, movedOn]));

        const search = await post("/api/company/users/select", {page: 1, limit: 10, name: "Departed"});
        expect(search.status).toBe(200);
        expect(search.body.data).toEqual([]);
        expect(search.body.total).toBe(0);

        const byId = await post("/api/company/users/select", {page: 1, limit: 10, administration: true, ids: [formerId, movedOnId]});
        expect(byId.status).toBe(200);
        expect(byId.body.data.map((o: {value: string; label: string}) => [o.value, o.label])).toEqual([[movedOnId, "Dan Departed"], [formerId, "Dora Departed"]]);
    });
});

describe("core accessible roles select by ids", {timeout: 60000}, () => {
    it("labels a role past the first page, never another company's or an admin role", async () => {
        const roles = insertedIds(await Role.collection.insertMany(["Accountant", "Broker", "Clerk"].map((name) => roleOf(companyId, name))));
        const admin = (await Role.collection.insertOne(roleOf(companyId, "Administrator", {isAdmin: true}))).insertedId.toString();
        const foreign = (await Role.collection.insertOne(roleOf(otherCompanyId, "Foreign"))).insertedId.toString();

        const firstPage = await post("/api/user/permissions/accessible/roles/select", {page: 1, limit: 1});
        expect(firstPage.status).toBe(200);
        expect(firstPage.body.data.map((o: {label: string}) => o.label)).toEqual(["Accountant"]);

        const byId = await post("/api/user/permissions/accessible/roles/select", {page: 1, limit: 1, name: "Acc", administration: false, ids: [roles[2], admin, foreign]});
        expect(byId.status).toBe(200);
        expect(byId.body.data.map((o: {value: string; label: string}) => [o.value, o.label])).toEqual([[roles[2], "Clerk"]]);
        expect(byId.body.total).toBe(1);
    });

    it("refuses ids that are not object ids", async () => {
        const res = await post("/api/user/permissions/accessible/roles/select", {page: 1, limit: 5, ids: [{$ne: null}]});
        expect(res.status).toBe(400);
    });
});
