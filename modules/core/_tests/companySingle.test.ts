import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";

const ids = vi.hoisted(() => ({platform: "64a000000000000000000001", shop: "64a000000000000000000002", clinic: "64a000000000000000000003"}));

// The harness stub, plus what authMW loads for this route: the platform-owner flag and the user's own companies (one).
vi.mock("@coreModule/utilities/middlewares/authMW", async () => {
    const {authMWStub} = await import("@coreModule/_tests/httpHarness");
    const {ObjectId: Id} = await import("mongodb");
    return {
        default: (scope?: string) => (req: {body: Record<string, any>}, res: unknown, next: () => void) =>
            authMWStub.default(scope)(req, res, () => {
                const companyId = String(req.body.company._id);
                req.body.company = {...req.body.company, isPlatformOwner: companyId === ids.platform};
                req.body.userInfo = {companies: [{_id: new Id(companyId)}]};
                // A role only in the company signed in to: elsewhere the user has no permissions, as for a platform
                // admin who is no member of the company opened.
                req.body.actionUserInfo = {getCompanyRolePermissions: async (id: unknown) => (String(id) === companyId ? req.body.actionUserCtx.permissions : [])};
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
import * as companiesRoute from "@coreModule/api/company/private/companies";
import Company from "@coreModule/database/schemas/company/company";

const platform = new ObjectId(ids.platform);
const shop = new ObjectId(ids.shop);
const clinic = new ObjectId(ids.clinic);
const app = appFor([{...companiesRoute, basePath: "/api/companies"}]);
const permissions = allPermissionTags([Company]);
const caller = (company: ObjectId, isAdmin: boolean): TestCaller =>
    ({userId: new ObjectId().toString(), companyId: company.toString(), isAdmin, permissions});
const single = (who: TestCaller, companyId: ObjectId) =>
    request(app).post("/api/companies/single").set(callerHeader(who)).send({_id: companyId.toString()});

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
    await Company.collection.insertMany([
        {_id: platform, company: platform, name: "Kudoo", vat: "P-1", isPlatformOwner: true, isActive: true, modules: ["core"], deletedAt: null},
        {_id: shop, company: platform, name: "Kudoo Market", vat: "S-1", isActive: true, modules: ["core"], deletedAt: null},
        {_id: clinic, company: platform, name: "Clinic", vat: "C-1", isActive: true, modules: ["core"], deletedAt: null},
    ]);
}));

describe("POST /api/companies/single (a company opened from a reference, D160)", () => {
    it("gives a user the companies they belong to, and no other", async () => {
        const shopAdmin = caller(shop, true);
        const own = await single(shopAdmin, shop);
        expect([own.status, own.body.name]).toEqual([200, "Kudoo Market"]);

        const other = await single(shopAdmin, clinic);
        expect([other.status, other.body.error_code]).toEqual([400, "company_not_found"]);
    });

    it("gives an admin of the platform company any company, and a non-admin there only their own", async () => {
        // Read with the admin's platform permissions: they hold no role in the shop (the Sign-ups view's sheet, P23.12).
        const opened = await single(caller(platform, true), shop);
        expect([opened.status, opened.body.error_code, opened.body.name, opened.body.vat]).toEqual([200, undefined, "Kudoo Market", "S-1"]);

        const refused = await single(caller(platform, false), shop);
        expect(refused.body.error_code).toBe("company_not_found");
    });
});
