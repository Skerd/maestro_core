import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";

const ids = vi.hoisted(() => ({shop: "64a000000000000000000012", clinic: "64a000000000000000000013", other: "64a000000000000000000014"}));

// The harness stub, plus what authMW loads for this route: the user's own companies (the shop and the clinic).
vi.mock("@coreModule/utilities/middlewares/authMW", async () => {
    const {authMWStub} = await import("@coreModule/_tests/httpHarness");
    const {ObjectId: Id} = await import("mongodb");
    return {
        default: (scope?: string) => (req: {body: Record<string, any>}, res: unknown, next: () => void) =>
            authMWStub.default(scope)(req, res, () => {
                req.body.company = {...req.body.company, isPlatformOwner: false};
                req.body.userInfo = {companies: [{_id: new Id(ids.shop)}, {_id: new Id(ids.clinic)}]};
                req.body.actionUserInfo = {getCompanyRolePermissions: async () => req.body.actionUserCtx.permissions};
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

/* TD-B253: the Companies page of a company admin (not the platform's) searches and filters its own companies. */

const shop = new ObjectId(ids.shop);
const clinic = new ObjectId(ids.clinic);
const other = new ObjectId(ids.other);
const app = appFor([{...companiesRoute, basePath: "/api/companies"}]);
const shopAdmin: TestCaller = {userId: new ObjectId().toString(), companyId: shop.toString(), isAdmin: true, permissions: allPermissionTags([Company])};
const list = (filter?: Record<string, unknown>) =>
    request(app).post("/api/companies").set(callerHeader(shopAdmin)).send({offset: 0, limit: 10, ...(filter ? {filter} : {})});
const names = (body: {data: {name: string}[]}) => body.data.map((row) => row.name);

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
        {_id: shop, company: shop, name: "Adriatic Market", vat: "S-1", isActive: true, modules: ["core"], deletedAt: null},
        {_id: clinic, company: shop, name: "Adriatic Clinic", vat: "C-1", isActive: true, modules: ["core"], deletedAt: null},
        {_id: other, company: other, name: "Other Market", vat: "O-1", isActive: true, modules: ["core"], deletedAt: null},
    ]);
}));

describe("POST /api/companies with a filter (TD-B253)", () => {
    it("lists the user's own companies, unfiltered", async () => {
        const res = await list();
        expect([res.status, res.body.error_code]).toEqual([200, undefined]);
        expect(names(res.body).sort()).toEqual(["Adriatic Clinic", "Adriatic Market"]);
    });

    it("narrows them by a search, as the page's search box sends it, never reaching another company", async () => {
        const res = await list({
            id: "root", operator: "and", rules: [],
            groups: [{id: "w1", operator: "or", groups: [], rules: [{id: "r1", field: "name", operator: "contains", value: "market"}]}],
        });
        expect([res.status, res.body.error_code, res.body.message]).toEqual([200, undefined, undefined]);
        expect(names(res.body)).toEqual(["Adriatic Market"]);
        expect(res.body.total).toBe(1);
    });

    it("narrows them by a filter rule", async () => {
        const res = await list({id: "root", operator: "and", groups: [], rules: [{id: "r1", field: "name", operator: "equals", value: "Adriatic Clinic"}]});
        expect([res.status, res.body.error_code]).toEqual([200, undefined]);
        expect(names(res.body)).toEqual(["Adriatic Clinic"]);
    });
});
