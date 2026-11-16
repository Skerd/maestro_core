import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";

const ids = vi.hoisted(() => ({platform: "64a000000000000000000001", shop: "64a000000000000000000002", withModule: "64a000000000000000000003"}));

// The harness stub, with the caller's company marked as the platform owner when it is the platform, as authMW loads it.
vi.mock("@coreModule/utilities/middlewares/authMW", async () => {
    const {authMWStub} = await import("@coreModule/_tests/httpHarness");
    return {
        default: (scope?: string) => (req: {body: Record<string, any>}, res: unknown, next: () => void) =>
            authMWStub.default(scope)(req, res, () => {
                req.body.company = {...req.body.company, isPlatformOwner: String(req.body.company._id) === ids.platform};
                next();
            }),
    };
});
vi.mock("@coreModule/utilities/middlewares/rateLimiter", () => ({
    rateLimiter: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import mongoose from "mongoose";
import {ObjectId} from "mongodb";
import request from "supertest";
import {allPermissionTags, appFor, callerHeader, type TestCaller} from "@coreModule/_tests/httpHarness";
import {asCrossTenant} from "@coreModule/utilities/endpoints/tenantScope";
import * as smtpServerRoute from "@coreModule/api/auxiliary/private/smtpServer";
import * as messagingProviderRoute from "@coreModule/api/auxiliary/private/messagingProvider";
import SmtpServer from "@coreModule/database/schemas/smtpServer/smtpServer";
import MessagingProvider from "@coreModule/database/schemas/messagingProvider/messagingProvider";
import Country from "@coreModule/database/schemas/country/country";
import {platformOnlyAccess, registerPlatformOnlyUse} from "@coreModule/database/plugins/platformOnlyPlugin";

const platform = new ObjectId(ids.platform);
const shop = new ObjectId(ids.shop);
const withModule = new ObjectId(ids.withModule);
const app = appFor([
    {...smtpServerRoute, basePath: "/api/auxiliary/smtpServer"},
    {...messagingProviderRoute, basePath: "/api/auxiliary/messagingProvider"},
]);
// Every caller holds every permission: what refuses them is the platform-only rule, not their role.
const permissions = allPermissionTags([SmtpServer, MessagingProvider]);
const caller = (company: ObjectId, modules: string[]): TestCaller =>
    ({userId: new ObjectId().toString(), companyId: company.toString(), isAdmin: true, permissions, modules});
const platformAdmin = caller(platform, ["core"]);
const shopAdmin = caller(shop, ["core", "eCommerce"]);
// A fixture module, registered the way a module's `moduleBootstrap.platformOnlyUses` does (core names no vertical).
const FIXTURE_MODULE = "fixtureCampaigns";
registerPlatformOnlyUse({model: "SmtpServer", module: FIXTURE_MODULE});
const moduleAdmin = caller(withModule, ["core", FIXTURE_MODULE]);
const list = (who: TestCaller, path: string) =>
    request(app).post(path).set(callerHeader(who)).send({offset: 0, limit: 20});
const smtpServer = {name: "Main", sequence: 10, host: "smtp.example.test", port: 587, encryption: "starttls", authType: "none", fromEmail: "noreply@example.test"};

beforeAll(async () => {
    await connectTestDatabase();
}, 120000);

afterAll(async () => {
    await disconnectTestDatabase();
});

beforeEach(() => asCrossTenant("test fixtures span companies", async () => {
    for (const collection of await mongoose.connection.db!.collections()) {
        await collection.deleteMany({});
    }
}));

describe("a platform-only model (platformOnlyPlugin, D161)", () => {
    it("is managed by the platform company", async () => {
        expect((await list(platformAdmin, "/api/auxiliary/smtpServer")).status).toBe(200);
        expect((await list(platformAdmin, "/api/auxiliary/messagingProvider")).status).toBe(200);
        const created = await request(app).put("/api/auxiliary/smtpServer").set(callerHeader(platformAdmin)).send(smtpServer);
        expect(created.status).toBe(200);
    });

    it("refuses every route and action to another company, whatever its role grants", async () => {
        for (const path of ["/api/auxiliary/smtpServer", "/api/auxiliary/messagingProvider"]) {
            const listed = await list(shopAdmin, path);
            expect([listed.status, listed.body.error_code]).toEqual([403, "platform_company_required"]);
        }
        const created = await request(app).put("/api/auxiliary/smtpServer").set(callerHeader(shopAdmin)).send(smtpServer);
        expect([created.status, created.body.error_code]).toEqual([403, "platform_company_required"]);
        const action = await request(app).post("/api/auxiliary/smtpServer/activate").set(callerHeader(shopAdmin)).send({_id: new ObjectId().toString()});
        expect([action.status, action.body.error_code]).toEqual([403, "platform_company_required"]);
    });

    it("lets a company whose module registered for the model keep its own rows: mail servers, not messaging providers", async () => {
        expect((await list(moduleAdmin, "/api/auxiliary/smtpServer")).status).toBe(200);
        const created = await request(app).put("/api/auxiliary/smtpServer").set(callerHeader(moduleAdmin)).send(smtpServer);
        expect(created.status).toBe(200);
        expect((await asCrossTenant("test reads the stored row", () => SmtpServer.findOne({}).lean()))?.company).toEqual(withModule);

        const providers = await list(moduleAdmin, "/api/auxiliary/messagingProvider");
        expect([providers.status, providers.body.error_code]).toEqual([403, "platform_company_required"]);
    });

    it("is absent from the access map for a company that may not use it, so the panel hides it", () => {
        const granted = {read: {name: {}}, write: {name: {}}, create: true, delete: true, restore: true};
        const denied = {read: false, write: false, create: false, delete: false, restore: false};
        expect(platformOnlyAccess(SmtpServer, granted, {isPlatformOwner: true}, ["core"])).toEqual(granted);
        expect(platformOnlyAccess(SmtpServer, granted, {isPlatformOwner: false}, ["core"])).toEqual(denied);
        expect(platformOnlyAccess(SmtpServer, granted, {isPlatformOwner: false}, ["core", FIXTURE_MODULE])).toEqual(granted);
        expect(platformOnlyAccess(MessagingProvider, granted, {isPlatformOwner: false}, ["core", FIXTURE_MODULE])).toEqual(denied);
        expect(platformOnlyAccess(Country, granted, {isPlatformOwner: false}, ["core"])).toEqual(granted);
    });
});
