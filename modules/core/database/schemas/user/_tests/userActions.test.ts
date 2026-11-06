import {afterAll, beforeAll, describe, expect, it, vi} from "vitest";
import {Types} from "mongoose";
import request from "supertest";
import {Router} from "express";

vi.mock("@coreModule/utilities/middlewares/authMW", async () => (await import("@coreModule/_tests/httpHarness")).authMWStub);

import {appFor, callerHeader, type TestCaller} from "@coreModule/_tests/httpHarness";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";
import {mountActions} from "@coreModule/api/crudRouterFactory";
import {actionPermissionEntries, actionPermissionTag} from "@coreModule/utilities/security/actionPermissions";
import User from "@coreModule/database/schemas/user/user";
import {UserActions} from "@coreModule/database/schemas/user/user.actions";

const router = Router();
mountActions(router, UserActions, User);
const app = appFor([{basePath: "/api/company/users", router}]);

const companyId = new Types.ObjectId();
const staff = new Types.ObjectId();
const colleague = new Types.ObjectId();
const outsider = new Types.ObjectId();
const unlockOthers = actionPermissionTag(User, "unlockActivation", "others")!;
const caller = (permissions: string[]): TestCaller => ({userId: staff.toString(), companyId: companyId.toString(), permissions});
const unlock = (permissions: string[], _id: Types.ObjectId) =>
    request(app).post("/api/company/users/unlockActivation").set(callerHeader(caller(permissions))).send({_id: _id.toString()});

const lockedUser = (_id: Types.ObjectId, companies: Types.ObjectId[]) => ({
    _id,
    username: `${_id.toString()}@test.local`,
    companies,
    requests: {activation: {lockedUntil: new Date(Date.now() + 3_600_000), attempts: 5}},
});
const lockOf = async (_id: Types.ObjectId) => (await User.collection.findOne({_id}))?.requests?.activation?.lockedUntil;

beforeAll(async () => {
    await connectTestDatabase();
    await User.collection.insertMany([
        lockedUser(staff, [companyId]),
        lockedUser(colleague, [companyId]),
        lockedUser(outsider, [new Types.ObjectId()]),
    ]);
}, 120000);

afterAll(async () => {
    await disconnectTestDatabase();
});

describe("user account-request actions (D65, TD-B07)", {timeout: 60000}, () => {
    it("are permissions of another user only", () => {
        const tags = actionPermissionEntries().map((entry) => entry.tag);
        expect(tags).toContain(unlockOthers);
        expect(tags).not.toContain(actionPermissionTag(User, "unlockActivation", "self"));
    });

    it("refuses a caller without the others permission, before touching the account", async () => {
        const refused = await unlock([actionPermissionTag(User, "unlockActivation", "self")!], colleague);
        expect(refused.status).toBe(403);
        expect(await lockOf(colleague)).toBeTruthy();
    });

    it("unlocks a colleague's activation, named in the body", async () => {
        const response = await unlock([unlockOthers], colleague);
        expect(response.status).toBe(200);
        expect(await lockOf(colleague)).toBeUndefined();
    });

    it("never acts on the caller or on someone outside the company", async () => {
        expect((await unlock([unlockOthers], staff)).status).toBe(403);
        expect(await lockOf(staff)).toBeTruthy();
        const outside = await unlock([unlockOthers], outsider);
        expect(outside.body.error_code).toBe("cant_access_this_user");
        expect(await lockOf(outsider)).toBeTruthy();
    });
});
