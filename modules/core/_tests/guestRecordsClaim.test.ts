import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";
import mongoose from "mongoose";
import {ObjectId} from "mongodb";
import bcrypt from "bcrypt";
import request from "supertest";

/*
 * P23.9: a verified account claims the guest records made with its email. Core lets every module this server runs do it
 * (`moduleBootstrap.onAccountVerified`) when an email gets verified and at each portal sign-in, never at a panel sign-in.
 * Fixture modules stand in for the verticals (CORE-07): one records what it gets, one always fails.
 */
const {calls} = vi.hoisted(() => ({calls: [] as Record<string, unknown>[]}));
vi.mock("@coreModule/utilities/middlewares/rateLimiter", () => ({
    rateLimiter: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("@coreModule/utilities/modules/enabledModules", async (importOriginal) => ({
    ...await importOriginal<typeof import("@coreModule/utilities/modules/enabledModules")>(),
    getEnabledModuleNames: () => ["core", "failingFixture", "guestFixture"],
}));
vi.mock("@coreModule/utilities/modules/moduleCompanyDefaults", async (importOriginal) => {
    const fixtures: Record<string, AccountVerifiedHook> = {
        failingFixture: async () => {
            throw new Error("the fixture module is down");
        },
        // What it sees outside any transaction tells whether the caller's work has committed already.
        guestFixture: async ({userId, email, session}) => {
            const db = (await import("mongoose")).default.connection.db!;
            const sessions = await db.collection("usersessions").countDocuments({user: userId});
            const verified = (await db.collection("users").findOne({_id: userId}))?.isEmailVerified;
            calls.push({userId: userId.toString(), email, inTransaction: session.inTransaction(), sessions, verified});
        },
    };
    return {
        ...await importOriginal<typeof import("@coreModule/utilities/modules/moduleCompanyDefaults")>(),
        moduleBootstrapHook: async (moduleName: string, hookName: string) =>
            hookName === "onAccountVerified" ? fixtures[moduleName] : undefined,
    };
});
// Google answers with the profile of `googleProfile.email`, verified by Google unless `verified` says otherwise.
const {googleProfile} = vi.hoisted(() => ({googleProfile: {email: "", verified: true}}));
vi.mock("axios", () => ({
    default: {
        post: async () => ({data: {access_token: "test-access-token"}}),
        get: async () => ({data: {email: googleProfile.email, email_verified: googleProfile.verified, given_name: "Nora", family_name: "New", sub: "google-1"}}),
    },
}));
vi.mock("@coreModule/environment", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@coreModule/environment")>();
    return {
        ...actual,
        AUTHENTICATION: {
            ...actual.AUTHENTICATION,
            ACTIVATE_GOOGLE_LOGIN: true,
            GOOGLE_CLIENT_ID: "test-client",
            GOOGLE_CLIENT_SECRET: "test-secret",
            GOOGLE_REDIRECT_URL: "http://localhost:5173/login/google",
        },
    };
});

import type {AccountVerifiedHook} from "@coreModule/utilities/modules/moduleCompanyDefaults";
import {appFor} from "@coreModule/_tests/httpHarness";
import Company from "@coreModule/database/schemas/company/company";
import Role from "@coreModule/database/schemas/role/role";
import User from "@coreModule/database/schemas/user/user";
import {PORTAL_ROOT_DOMAIN} from "@coreModule/environment";
import {router as loginRouter} from "@coreModule/api/user/public/login";
import {router as activateAccountRouter} from "@coreModule/api/user/public/activateAccount";
import {claimGuestRecords} from "@coreModule/database/schemas/user/user.helper";
import {getLogger} from "@coreModule/loggers/serverLog";
import {runInTransaction} from "@coreModule/utilities/middlewares/runInTransaction";

const app = appFor([
    {basePath: "/api/user/login", router: loginRouter, module: "core"},
    {basePath: "/api/user/activateAccount", router: activateAccountRouter, module: "core"},
]);
const logger = getLogger("guest_records_claim_test");
const platform = new ObjectId();
const shop = new ObjectId();
const roles = {webClient: new ObjectId(), shopAdmin: new ObjectId(), shopCustomer: new ObjectId()};
const userId = new ObjectId();
const USERNAME = "Ada.Guest@Example.com";
const password = "Secret#Pass1";
const apex = `http://${PORTAL_ROOT_DOMAIN}:5212`;
const panel = "http://localhost:5173";
const headers = (origin: string) => ({"Origin": origin, "x-device-id": "test-device", "User-Agent": "vitest"});

beforeAll(async () => {
    await connectTestDatabase();
    await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
}, 120000);

afterAll(async () => {
    await disconnectTestDatabase();
});

beforeEach(async () => {
    calls.length = 0;
    for (const collection of await mongoose.connection.db!.collections()) {
        await collection.deleteMany({});
    }
    // Raw inserts: saving a new Company seeds its roles, bot and jobs, which these tests do not need.
    await Company.collection.insertMany([
        {_id: platform, company: platform, name: "Arpeggio", vat: "P", allowedDomains: ["*"], isActive: true, isPlatformOwner: true, deletedAt: null},
        {_id: shop, company: shop, name: "Shop", vat: "S", allowedDomains: ["localhost", "*"], isActive: true, deletedAt: null},
    ]);
    await Role.collection.insertMany([
        {_id: roles.webClient, name: "Web Client", slug: "web_client", company: platform, isSignupDefault: true, isAdmin: false, permissions: []},
        {_id: roles.shopAdmin, name: "Admin", slug: "admin_shop", company: shop, isSignupDefault: false, isAdmin: true, permissions: []},
        {_id: roles.shopCustomer, name: "Customer", slug: "customer_shop", company: shop, isSignupDefault: true, isAdmin: false, permissions: []},
    ]);
    await User.collection.insertOne({
        _id: userId, username: USERNAME, password: await bcrypt.hash(password, 10), name: "Ada", surname: "Guest",
        fullName: "Ada Guest", isEmailVerified: true, companies: [shop], mfaSecret: "",
        roles: [{_id: new ObjectId(), company: shop, roles: [roles.shopAdmin], rolesCount: 1, active: "active", unsuccessfulLogins: 0, lockedOutUntil: null}],
    });
});

const signIn = (origin: string, secret = password) =>
    request(app).post("/api/user/login").set(headers(origin)).send({username: USERNAME, password: secret});

describe("claiming guest records at sign-in and verification (P23.9)", {timeout: 30000}, () => {
    it("lets every module claim once a portal sign-in has committed, each in its own transaction, past one that fails", async () => {
        const res = await signIn(apex);

        expect([res.status, res.body.error_code, typeof res.body.token]).toEqual([200, undefined, "string"]);
        expect(calls).toEqual([{userId: userId.toString(), email: "ada.guest@example.com", inTransaction: true, sessions: 1, verified: true}]);
    });

    it("claims nothing at a panel sign-in", async () => {
        const res = await signIn(panel);

        expect([res.status, typeof res.body.token]).toEqual([200, "string"]);
        expect(calls).toEqual([]);
    });

    it("claims nothing when the portal sign-in fails", async () => {
        const res = await signIn(apex, "Wrong#Pass1");

        expect([res.status, res.body.token]).toEqual([400, undefined]);
        expect(calls).toEqual([]);
    });

    it("claims with the address an activation verifies, a changed one included", async () => {
        await User.collection.updateOne({_id: userId}, {$set: {
            isEmailVerified: false,
            requests: {activation: {code: "481516", email: "New.Address@Example.com"}},
        }});

        const res = await request(app).put("/api/user/activateAccount").set(headers(panel)).send({code: "481516"});

        expect([res.status, res.body.error_code]).toEqual([200, undefined]);
        expect(calls).toEqual([{userId: userId.toString(), email: "new.address@example.com", inTransaction: true, sessions: 0, verified: true}]);
    });

    it("claims for a new account whose email Google verified, even on the panel, but not for an existing one there", async () => {
        googleProfile.email = "nora.new@example.com";
        const created = await request(app).post("/api/user/login/thirdParty").set(headers(panel)).send({code: "google-code", platform: "google"});

        expect([created.status, created.body.error_code]).toEqual([200, undefined]);
        const nora = await User.collection.findOne({username: "nora.new@example.com"});
        expect(calls).toEqual([{userId: String(nora?._id), email: "nora.new@example.com", inTransaction: true, sessions: 1, verified: true}]);

        calls.length = 0;
        googleProfile.email = USERNAME;
        const existing = await request(app).post("/api/user/login/thirdParty").set(headers(panel)).send({code: "google-code", platform: "google"});

        expect([existing.status, existing.body.error_code]).toEqual([200, undefined]);
        expect(calls).toEqual([]);
    });

    it("refuses a Google sign-in whose email Google has not verified: no account, no claim", async () => {
        googleProfile.email = "unverified@example.com";
        googleProfile.verified = false;
        try {
            const res = await request(app).post("/api/user/login/thirdParty").set(headers(panel)).send({code: "google-code", platform: "google"});

            expect([res.status, res.body.error_code]).toEqual([400, "third_party_email_not_verified"]);
            expect(await User.collection.countDocuments({username: "unverified@example.com"})).toBe(0);
            expect(calls).toEqual([]);
        } finally {
            googleProfile.verified = true;
        }
    });

    it("does nothing for an account whose email is not verified", async () => {
        await runInTransaction(logger, (session) => claimGuestRecords(
            {_id: userId, username: USERNAME, isEmailVerified: false},
            {session, logger, languageCode: "en-US"},
        ));

        expect(calls).toEqual([]);
    });
});
