import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";
import mongoose from "mongoose";
import {ObjectId} from "mongodb";
import request from "supertest";

// The harness stub, with the caller's company marked as the platform owner, as authMW loads it.
vi.mock("@coreModule/utilities/middlewares/authMW", async () => {
    const {authMWStub} = await import("@coreModule/_tests/httpHarness");
    return {
        default: (scope?: string) => (req: {body: Record<string, any>}, res: unknown, next: () => void) =>
            authMWStub.default(scope)(req, res, () => {
                req.body.company = {...req.body.company, isPlatformOwner: true};
                next();
            }),
    };
});
vi.mock("@coreModule/utilities/middlewares/rateLimiter", () => ({
    rateLimiter: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import {allPermissionTags, appFor, callerHeader, type TestCaller} from "@coreModule/_tests/httpHarness";
import Company from "@coreModule/database/schemas/company/company";
import Media from "@coreModule/database/schemas/media/media";
import {router} from "@coreModule/api/platform/private/companies";
import {asCrossTenant} from "@coreModule/utilities/endpoints/tenantScope";

const platform = new ObjectId();
const shop = new ObjectId();
const logo = new ObjectId();
const app = appFor([{basePath: "/api/platform/companies", router, module: "core"}]);
const admin: TestCaller = {userId: new ObjectId().toString(), companyId: platform.toString(), isAdmin: true, modules: ["core"]};
const stored = () => asCrossTenant("test reads the company row", () => Company.collection.findOne({_id: shop}));

beforeAll(async () => {
    await connectTestDatabase();
    await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
}, 120000);

afterAll(async () => {
    await disconnectTestDatabase();
});

beforeEach(() => asCrossTenant("test fixtures span companies", async () => {
    for (const collection of await mongoose.connection.db!.collections()) await collection.deleteMany({});
    await Company.collection.insertMany([
        {_id: platform, company: platform, name: "Platform", vat: "P-1", isPlatformOwner: true, isActive: true, modules: ["core"], deletedAt: null},
        {_id: shop, company: shop, name: "Store", vat: "S-1", logo, isActive: true, modules: ["core"], deletedAt: null},
    ]);
    await Media.collection.insertOne({_id: logo, company: shop, originalName: "logo.png", deletedAt: null});
}));

// TD-B188: saving a company with a logo ran its public-media plugin's media update in the platform's tenant, which
// tenant scoping refused (`tenant_scope_violation`), so the platform could neither change its modules nor hide it.
describe("the platform admin on a company with a logo (TD-B188)", {timeout: 60000}, () => {
    it("changes its modules", async () => {
        const res = await request(app).put(`/api/platform/companies/modules/${shop.toString()}`).set(callerHeader(admin)).send({modules: ["core"]});
        expect([res.status, res.body.error_code]).toEqual([200, undefined]);
    });

    it("hides it from the portal and shows it again", async () => {
        const hide = await request(app).put(`/api/platform/companies/portalVisibility/${shop.toString()}`).set(callerHeader(admin)).send({hiddenFromPortal: true});
        expect([hide.status, hide.body.error_code]).toEqual([200, undefined]);
        expect((await stored())?.hiddenFromPortal).toBe(true);
    });
});

// The platform's company list populated each logo from the platform's tenant, found nothing and dropped the id, so
// every card showed initials (core QA 2026-11-17, TD-B236).
describe("the platform's company list", {timeout: 60000}, () => {
    it("keeps the id of a logo stored in the company's own tenant", async () => {
        const reader: TestCaller = {...admin, permissions: allPermissionTags([Company])};
        const res = await request(app).post("/api/platform/companies").set(callerHeader(reader)).send({offset: 0, limit: 10});
        expect([res.status, res.body.error_code]).toEqual([200, undefined]);
        const store = (res.body.data as {name: string; logo?: string}[]).find((row) => row.name === "Store");
        expect(store?.logo).toBe(logo.toString());
    });
});
