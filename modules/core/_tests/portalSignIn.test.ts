import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";
import mongoose from "mongoose";
import {ObjectId} from "mongodb";
import bcrypt from "bcrypt";
import request from "supertest";

vi.mock("@coreModule/utilities/middlewares/rateLimiter", () => ({
    rateLimiter: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import {appFor} from "@coreModule/_tests/httpHarness";
import Company from "@coreModule/database/schemas/company/company";
import Role from "@coreModule/database/schemas/role/role";
import User from "@coreModule/database/schemas/user/user";
import {PORTAL_ROOT_DOMAIN} from "@coreModule/environment";
import {router as loginRouter} from "@coreModule/api/user/public/login";

// D101: one account works on the portal. A member of another company who signs in on the portal apex joins the
// platform company as a customer (its sign-up default role), and is signed in there.
const app = appFor([{basePath: "/api/user/login", router: loginRouter, module: "core"}]);

const platform = new ObjectId();
const estates = new ObjectId();
const webClient = new ObjectId();
const estatesManager = new ObjectId();
const userId = new ObjectId();
const apex = `http://${PORTAL_ROOT_DOMAIN}:5212`;
const panel = "http://localhost:5173";
const password = "Secret#Pass1";

beforeAll(async () => {
    await connectTestDatabase();
    await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
}, 120000);

afterAll(async () => {
    await disconnectTestDatabase();
});

beforeEach(async () => {
    for (const collection of await mongoose.connection.db!.collections()) {
        await collection.deleteMany({});
    }
    // Raw inserts: saving a new Company seeds its roles, bot and jobs, which these tests do not need.
    await Company.collection.insertMany([
        {_id: platform, company: platform, name: "Arpeggio", vat: "P", allowedDomains: ["*"], isActive: true, isPlatformOwner: true, deletedAt: null},
        {_id: estates, company: estates, name: "Estates", vat: "E", allowedDomains: ["*"], isActive: true, deletedAt: null},
    ]);
    await Role.collection.insertMany([
        {_id: webClient, name: "Web Client", slug: "web_client", company: platform, isSignupDefault: true, isAdmin: false, permissions: []},
        {_id: estatesManager, name: "PD Manager", slug: "pd_manager", company: estates, isSignupDefault: false, isAdmin: false, permissions: []},
    ]);
    await User.collection.insertOne({
        _id: userId, username: "manager@estates.com", password: await bcrypt.hash(password, 10), name: "Pat", surname: "Manager",
        fullName: "Pat Manager", isEmailVerified: true, companies: [estates], mfaSecret: "",
        roles: [{_id: new ObjectId(), company: estates, roles: [estatesManager], rolesCount: 1, active: "active", unsuccessfulLogins: 0, lockedOutUntil: null}],
    });
});

const signIn = (origin: string, secret = password) =>
    request(app).post("/api/user/login").set({"Origin": origin, "x-device-id": "test-device", "User-Agent": "vitest"}).send({username: "manager@estates.com", password: secret});
const memberships = async () => {
    const user = (await User.collection.findOne({_id: userId}))!;
    return {
        companies: (user.companies as ObjectId[]).map(String),
        roles: (user.roles as {company: ObjectId; roles: ObjectId[]; active: string}[]).map((role) => [String(role.company), role.roles.map(String), role.active]),
    };
};

describe("portal sign-in of another company's member (D101)", () => {
    it("joins the platform company as a Web Client and signs in there", async () => {
        const res = await signIn(apex);

        expect([res.status, res.body.error_code, typeof res.body.token]).toEqual([200, undefined, "string"]);
        expect(await memberships()).toEqual({
            companies: [estates.toString(), platform.toString()],
            roles: [
                [estates.toString(), [estatesManager.toString()], "active"],
                [platform.toString(), [webClient.toString()], "active"],
            ],
        });
    });

    it("does not add the membership twice on a second portal sign-in", async () => {
        await signIn(apex);
        const again = await signIn(apex);

        expect(again.status).toBe(200);
        expect((await memberships()).roles).toHaveLength(2);
    });

    it("signs in on the panel as today, without joining the platform company", async () => {
        const res = await signIn(panel);

        expect([res.status, typeof res.body.token]).toEqual([200, "string"]);
        expect((await memberships()).companies).toEqual([estates.toString()]);
    });

    it("adds no membership when the password is wrong, and signs nobody in", async () => {
        const res = await signIn(apex, "Wrong#Pass1");

        expect([res.status, res.body.token]).toEqual([400, undefined]);
        expect((await memberships()).companies).toEqual([estates.toString()]);
    });

    it("keeps refusing an inactive platform membership", async () => {
        await User.collection.updateOne({_id: userId}, {
            $push: {roles: {_id: new ObjectId(), company: platform, roles: [webClient], rolesCount: 1, active: "inactive", unsuccessfulLogins: 0, lockedOutUntil: null}} as never,
            $addToSet: {companies: platform},
        });

        const res = await signIn(apex);

        expect(res.body.error_code).toBe("user_not_active");
        expect((await memberships()).roles).toHaveLength(2);
    });
});
