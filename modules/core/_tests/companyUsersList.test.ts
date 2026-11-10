import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";
import mongoose from "mongoose";
import {ObjectId} from "mongodb";
import request from "supertest";

const company = new ObjectId();
const callerId = new ObjectId();

// The harness stub sets no `userInfo`; the list excludes the caller by `userInfo._id`.
vi.mock("@coreModule/utilities/middlewares/authMW", async () => {
    const {authMWStub} = await import("@coreModule/_tests/httpHarness");
    return {
        default: (scope?: string) => (req: {body: Record<string, unknown>}, res: unknown, next: () => void) => {
            req.body.userInfo = {_id: callerId};
            return authMWStub.default(scope)(req, res, next);
        },
    };
});
vi.mock("@coreModule/utilities/middlewares/rateLimiter", () => ({
    rateLimiter: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import {allPermissionTags, appFor, callerHeader, type TestCaller} from "@coreModule/_tests/httpHarness";
import User from "@coreModule/database/schemas/user/user";
import Role from "@coreModule/database/schemas/role/role";
import * as usersRoute from "@coreModule/api/company/private/users";

const app = appFor([{basePath: "/api/company/users", router: usersRoute.router, module: "core"}]);
const staff: TestCaller = {userId: callerId.toString(), companyId: company.toString(), isAdmin: false, permissions: allPermissionTags([User, Role]), modules: ["core"]};

beforeAll(async () => {
    await connectTestDatabase();
    await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
}, 120000);

afterAll(async () => {
    await disconnectTestDatabase();
});

beforeEach(async () => {
    await Promise.all([User.collection.deleteMany({}), Role.collection.deleteMany({})]);
});

describe("company users list", {timeout: 30000}, () => {
    // `roles.company` is not a readable field, but the mapper picks this company's membership by it: without it every
    // row came back with no roles and status "inactive".
    it("returns each member's roles and status in this company", async () => {
        const roleId = new ObjectId();
        await Role.collection.insertOne({_id: roleId, company, name: "Manager", slug: "test:default:manager", isSignupDefault: false, permissions: [], deletedAt: null});
        await User.collection.insertOne({
            _id: new ObjectId(),
            username: "member@example.com",
            name: "Mem",
            surname: "Ber",
            companies: [company],
            roles: [{company, roles: [roleId], active: "active"}],
            isBot: false,
            registerDate: new Date(),
            deletedAt: null,
        });

        const res = await request(app).post("/api/company/users").set(callerHeader(staff)).send({offset: 0, limit: 10, administration: true});

        expect(res.body.error_code ?? "ok").toBe("ok");
        expect(res.body.total).toBe(1);
        const row = res.body.data[0] as {status: string; roles: Array<{slug?: string; name?: string}>; company?: unknown};
        expect(row.status).toBe("active");
        expect(row.roles.map((role) => role.slug ?? role.name)).toEqual(["test:default:manager"]);
    });
});
