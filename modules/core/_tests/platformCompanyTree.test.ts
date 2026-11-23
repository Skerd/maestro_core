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
import {router} from "@coreModule/api/platform/private/companies";
import {asCrossTenant} from "@coreModule/utilities/endpoints/tenantScope";
import type {CompanyTreeNode} from "armonia/src/modules/core/api/platform/private/companies/platformModules.dto";

/* The platform's company hierarchy: every company with the company it was created under. */

const platform = new ObjectId();
const group = new ObjectId();
const branch = new ObjectId();
const removed = new ObjectId();
const logo = new ObjectId();
const app = appFor([{basePath: "/api/platform/companies", router, module: "core"}]);
const admin: TestCaller = {userId: new ObjectId().toString(), companyId: platform.toString(), isAdmin: true, modules: ["core"]};
const reader: TestCaller = {...admin, permissions: allPermissionTags([Company])};
const tree = (caller: TestCaller) => request(app).get("/api/platform/companies/tree").set(callerHeader(caller));

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
        {_id: platform, company: platform, name: "Platform", vat: "P-1", isPlatformOwner: true, isActive: true, modules: ["core"], parentCompany: null, deletedAt: null},
        {_id: group, company: platform, name: "Group", vat: "G-1", logo, isActive: true, modules: ["core"], parentCompany: platform, portalApproval: {status: "pending"}, deletedAt: null},
        {_id: branch, company: group, name: "Branch", isActive: false, modules: ["core"], parentCompany: group, signupSource: {via: "selfServe", refCompany: group}, deletedAt: null},
        {_id: removed, company: group, name: "Removed", isActive: true, modules: ["core"], parentCompany: group, deletedAt: new Date()},
    ]);
}));

describe("the platform's company hierarchy", {timeout: 60000}, () => {
    it("lists every company by name with the company it was created under", async () => {
        const res = await tree(reader);
        expect([res.status, res.body.error_code]).toEqual([200, undefined]);
        expect(res.body.data as CompanyTreeNode[]).toEqual([
            {
                _id: branch.toString(), name: "Branch", parentCompany: group.toString(), isActive: false, isPlatformOwner: false,
                signupSource: {via: "selfServe", refCompany: group.toString()},
            },
            {
                _id: group.toString(), name: "Group", vat: "G-1", logo: logo.toString(), parentCompany: platform.toString(),
                isActive: true, isPlatformOwner: false, portalApprovalStatus: "pending",
            },
            {_id: platform.toString(), name: "Platform", vat: "P-1", isActive: true, isPlatformOwner: true},
        ]);
    });

    it("leaves out what the caller may not read", async () => {
        const partial: TestCaller = {...admin, permissions: reader.permissions!.filter((tag) => !["companies[read:vat]", "companies[read:logo]", "companies[read:signupSource]"].includes(tag))};
        const res = await tree(partial);
        expect([res.status, res.body.error_code]).toEqual([200, undefined]);
        expect((res.body.data as CompanyTreeNode[]).find((node) => node.name === "Group")).toEqual({
            _id: group.toString(), name: "Group", parentCompany: platform.toString(), isActive: true, isPlatformOwner: false, portalApprovalStatus: "pending",
        });
        expect((res.body.data as CompanyTreeNode[]).find((node) => node.name === "Branch")).not.toHaveProperty("signupSource");
    });

    it("is refused to anyone but a platform admin", async () => {
        const res = await tree({...reader, isAdmin: false});
        expect([res.status, res.body.error_code]).toEqual([403, "platform_admin_required"]);
    });
});
