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
import UserSession from "@coreModule/database/schemas/userSession/userSession";
import {router as loginRouter} from "@coreModule/api/user/public/login";

/* TD-B255: a person with several businesses on one panel signs in to the one they last worked in. */

const app = appFor([{basePath: "/api/user/login", router: loginRouter, module: "core"}]);
const rentals = new ObjectId();
const clinic = new ObjectId();
const roles = {rentals: new ObjectId(), clinic: new ObjectId()};
const userId = new ObjectId();
const password = "Secret#Pass1";
const panel = "http://localhost:5173";

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
    // Raw inserts: saving a new Company seeds its roles, bot and jobs, which these tests do not need. Both businesses
    // list the panel's host, as a self-serve business does (D178).
    await Company.collection.insertMany([
        {_id: rentals, company: rentals, name: "Rentals", allowedDomains: ["localhost", "*"], isActive: true, deletedAt: null},
        {_id: clinic, company: clinic, name: "Clinic", allowedDomains: ["localhost", "*"], isActive: true, deletedAt: null},
    ]);
    await Role.collection.insertMany([
        {_id: roles.rentals, name: "Admin", slug: "admin_rentals", company: rentals, isSignupDefault: false, isAdmin: true, permissions: []},
        {_id: roles.clinic, name: "Admin", slug: "admin_clinic", company: clinic, isSignupDefault: false, isAdmin: true, permissions: []},
    ]);
    const membership = (company: ObjectId, role: ObjectId) =>
        ({_id: new ObjectId(), company, roles: [role], rolesCount: 1, active: "active", unsuccessfulLogins: 0, lockedOutUntil: null});
    await User.collection.insertOne({
        _id: userId, username: "owner@example.com", password: await bcrypt.hash(password, 10), name: "Ola", surname: "Owner",
        fullName: "Ola Owner", isEmailVerified: true, companies: [rentals, clinic], mfaSecret: "",
        roles: [membership(rentals, roles.rentals), membership(clinic, roles.clinic)],
    });
});

/** A session the person had in `company`, last active at `at` (sign-in and switching keep it current), on a host. */
const sessionIn = (company: ObjectId, at: string, host = "localhost") => UserSession.collection.insertOne({
    user: userId, company, deviceId: "other-device", sessionId: new ObjectId().toString(), userAgent: "vitest", ipAddress: "127.0.0.1",
    isActive: true, lastActiveAt: new Date(at), expiresAt: new Date("2099-01-01T00:00:00Z"), createdAt: new Date(at), host,
});

/** The business the sign-in opened, read from its token. */
async function signedInto(): Promise<string> {
    const res = await request(app).post("/api/user/login").set({"Origin": panel, "x-device-id": "test-device", "User-Agent": "vitest"})
        .send({username: "owner@example.com", password});
    expect([res.status, res.body.error_code]).toEqual([200, undefined]);
    const payload = JSON.parse(Buffer.from(String(res.body.token).split(".")[1], "base64url").toString("utf8")) as {company: {_id: string}};
    return payload.company._id;
}

describe("sign-in with several businesses on one panel (TD-B255)", {timeout: 30000}, () => {
    it("opens the business the person last worked in", async () => {
        await sessionIn(rentals, "2026-11-20T10:00:00Z");
        await sessionIn(clinic, "2026-11-22T10:00:00Z");
        expect(await signedInto()).toBe(clinic.toString());
    });

    it("follows the newest session, whichever business the database lists first", async () => {
        await sessionIn(clinic, "2026-11-20T10:00:00Z");
        await sessionIn(rentals, "2026-11-22T10:00:00Z");
        expect(await signedInto()).toBe(rentals.toString());
        // That sign-in is now the newest session: signing in again stays there.
        expect(await signedInto()).toBe(rentals.toString());
    });

    it("weighs a business open on any host against one naming the panel, and prefers the named one without a session", async () => {
        // The clinic is an older business open everywhere; the rentals a new self-serve one naming the panel.
        await Company.collection.updateOne({_id: clinic}, {$set: {allowedDomains: ["*"]}});
        expect(await signedInto()).toBe(rentals.toString());
        await UserSession.collection.deleteMany({});
        await sessionIn(rentals, "2026-11-20T10:00:00Z");
        await sessionIn(clinic, "2026-11-22T10:00:00Z");
        expect(await signedInto()).toBe(clinic.toString());
    });

    it("does not let a newer visit on another host (the portal) decide which business the panel opens", async () => {
        await sessionIn(rentals, "2026-11-20T10:00:00Z");
        // Signing in on the portal makes a session on the portal's host, newer than the panel's.
        await sessionIn(clinic, "2026-11-22T10:00:00Z", "portal.localhost");
        expect(await signedInto()).toBe(rentals.toString());
    });
});
