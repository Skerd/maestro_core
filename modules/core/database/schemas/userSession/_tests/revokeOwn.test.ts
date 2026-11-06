import {afterAll, beforeAll, describe, expect, it, vi} from "vitest";
import {Types} from "mongoose";
import request from "supertest";
import {Router} from "express";

vi.mock("@coreModule/utilities/middlewares/authMW", async () => (await import("@coreModule/_tests/httpHarness")).authMWStub);
vi.mock("@coreModule/connections/connectToWebSocketServer", () => ({pushWebsocketMessage: vi.fn()}));

import {appFor, callerHeader, type TestCaller} from "@coreModule/_tests/httpHarness";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";
import {mountActions} from "@coreModule/api/crudRouterFactory";
import {withTenant} from "@coreModule/utilities/endpoints/tenantScope";
import UserSession from "@coreModule/database/schemas/userSession/userSession";
import {UserSessionActions} from "@coreModule/database/schemas/userSession/userSession.actions";

const router = Router();
mountActions(router, UserSessionActions, UserSession);
const app = appFor([{basePath: "/api/user/userSession", router}]);

const companyId = new Types.ObjectId();
const me = new Types.ObjectId();
const colleague = new Types.ObjectId();
// No role holds the user-session permissions (TD-B24): the caller has none.
const caller = (userId: Types.ObjectId): TestCaller => ({userId: userId.toString(), companyId: companyId.toString(), permissions: []});

function sessionOf(user: Types.ObjectId) {
    return withTenant(companyId, () => UserSession.create({
        user,
        company: companyId,
        sessionId: new Types.ObjectId().toString(),
        deviceId: "device",
        userAgent: "test",
        ipAddress: "127.0.0.1",
        expiresAt: new Date(Date.now() + 3_600_000),
        isActive: true,
    }));
}

const isActive = async (id: Types.ObjectId) =>
    (await withTenant(companyId, () => UserSession.findById(id).lean()))?.isActive;

beforeAll(async () => {
    await connectTestDatabase();
}, 120000);

afterAll(async () => {
    await disconnectTestDatabase();
});

describe("revokeOwn (TD-B24)", {timeout: 60000}, () => {
    it("lets any signed-in user end one of their own sessions", async () => {
        const mine = await sessionOf(me);
        const response = await request(app).post("/api/user/userSession/revokeOwn")
            .set(callerHeader(caller(me))).send({_id: mine._id.toString()});
        expect(response.status).toBe(200);
        expect(await isActive(mine._id)).toBe(false);
    });

    it("never ends another user's session", async () => {
        const theirs = await sessionOf(colleague);
        const response = await request(app).post("/api/user/userSession/revokeOwn")
            .set(callerHeader(caller(me))).send({_id: theirs._id.toString()});
        expect(response.status).not.toBe(200);
        expect(await isActive(theirs._id)).toBe(true);
    });

    it("keeps revoking others' sessions a role permission", async () => {
        const theirs = await sessionOf(colleague);
        const response = await request(app).post("/api/user/userSession/revoke")
            .set(callerHeader(caller(me))).send({_id: theirs._id.toString()});
        expect(response.status).toBe(403);
        expect(await isActive(theirs._id)).toBe(true);
    });
});
