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
const {decided} = vi.hoisted(() => ({decided: [] as unknown[]}));
vi.mock("@coreModule/domain/company/companySignupNotices", () => ({
    notifyCompanySignedUp: async () => undefined,
    notifyPortalApprovalDecided: async (...args: unknown[]) => { decided.push(args.slice(0, 2)); },
}));

import {allPermissionTags, appFor, callerHeader, type TestCaller} from "@coreModule/_tests/httpHarness";
import Company from "@coreModule/database/schemas/company/company";
import {router} from "@coreModule/api/platform/private/companies";
import {asCrossTenant} from "@coreModule/utilities/endpoints/tenantScope";
import {portalListedCompanyIds} from "@coreModule/utilities/marketing/portalCompanies";

/* D178: the platform decides whether the apex lists a self-serve company, and marks companies verified. */

const platform = new ObjectId();
const pending = new ObjectId();
const created = new ObjectId();
const app = appFor([{basePath: "/api/platform/companies", router, module: "core"}]);
const admin: TestCaller = {userId: new ObjectId().toString(), companyId: platform.toString(), isAdmin: true, modules: ["core"]};
const stored = (id: ObjectId) => asCrossTenant("test reads the company row", () => Company.collection.findOne({_id: id}));
const decide = (id: ObjectId, body: Record<string, unknown>) =>
    request(app).put(`/api/platform/companies/portalApproval/${id.toString()}`).set(callerHeader(admin)).send(body);
const verify = (id: ObjectId, verified: boolean) =>
    request(app).put(`/api/platform/companies/verification/${id.toString()}`).set(callerHeader(admin)).send({verified});

beforeAll(async () => {
    await connectTestDatabase();
    await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
}, 120000);

afterAll(async () => {
    await disconnectTestDatabase();
});

beforeEach(() => asCrossTenant("test fixtures span companies", async () => {
    decided.length = 0;
    for (const collection of await mongoose.connection.db!.collections()) await collection.deleteMany({});
    await Company.collection.insertMany([
        {_id: platform, company: platform, name: "Platform", vat: "P-1", isPlatformOwner: true, isProtected: true, isActive: true, modules: ["core"], deletedAt: null},
        {_id: pending, company: platform, name: "New Rentals", isActive: true, modules: ["core"], portalApproval: {status: "pending"}, deletedAt: null},
        {_id: created, company: platform, name: "Old Shop", vat: "O-1", isActive: true, modules: ["core"], deletedAt: null},
    ]);
}));

describe("the platform's approval of self-serve companies", {timeout: 60000}, () => {
    it("approves a waiting company and tells its admins", async () => {
        const res = await decide(pending, {status: "approved"});
        expect([res.status, res.body.error_code]).toEqual([200, undefined]);
        const row = await stored(pending);
        expect(row!.portalApproval).toMatchObject({status: "approved", decidedBy: new ObjectId(admin.userId)});
        expect(row!.portalApproval.decidedAt).toBeInstanceOf(Date);
        expect(decided).toEqual([[{_id: pending, name: "New Rentals"}, {status: "approved", reason: undefined}]]);
    });

    it("rejects with a reason the company's admins are told", async () => {
        const res = await decide(pending, {status: "rejected", reason: "  Not a real business  "});
        expect([res.status, res.body.data?.portalApproval?.reason ?? res.body.portalApproval?.reason]).toEqual([200, "Not a real business"]);
        expect((await stored(pending))!.portalApproval).toMatchObject({status: "rejected", reason: "Not a real business"});
        expect(decided).toEqual([[{_id: pending, name: "New Rentals"}, {status: "rejected", reason: "Not a real business"}]]);
    });

    it("never keeps a protected company off the portal", async () => {
        const res = await decide(platform, {status: "rejected"});
        expect(res.body.error_code).toBe("company_is_protected");
        expect((await stored(platform))!.portalApproval).toBeUndefined();
    });

    it("refuses a decision other than approve or reject", async () => {
        const res = await decide(pending, {status: "pending"});
        expect(res.status).toBe(400);
        expect((await stored(pending))!.portalApproval.status).toBe("pending");
    });
});

describe("verifying a company's NIPT/VAT", {timeout: 60000}, () => {
    it("needs a VAT, marks the company verified and takes the mark back", async () => {
        const without = await verify(pending, true);
        expect(without.body.error_code).toBe("company_verification_needs_vat");

        const on = await verify(created, true);
        expect([on.status, on.body.error_code]).toEqual([200, undefined]);
        expect((await stored(created))!.verifiedAt).toBeInstanceOf(Date);
        expect((await stored(created))!.verifiedBy).toEqual(new ObjectId(admin.userId));

        const off = await verify(created, false);
        expect([off.status, off.body.error_code]).toEqual([200, undefined]);
        expect((await stored(created))!.verifiedAt).toBeUndefined();
    });
});

describe("the apex listing (D178)", {timeout: 60000}, () => {
    it("lists companies the platform made or approved, never a waiting or rejected one, while their own scope still works", async () => {
        const rejected = new ObjectId();
        const approved = new ObjectId();
        await asCrossTenant("test fixtures span companies", () => Company.collection.insertMany([
            {_id: rejected, company: platform, name: "Refused", isActive: true, modules: ["core"], portalApproval: {status: "rejected"}, deletedAt: null},
            {_id: approved, company: platform, name: "Approved", isActive: true, modules: ["core"], portalApproval: {status: "approved"}, deletedAt: null},
        ]));
        const apex = await asCrossTenant("test lists the apex", () => portalListedCompanyIds("core", {}, {}));
        expect(apex.map(String).sort()).toEqual([platform, created, approved].map(String).sort());

        const ownSite = await asCrossTenant("test lists one company's own site", () => portalListedCompanyIds("core", {}, {companyId: pending}));
        expect(ownSite.map(String)).toEqual([pending.toString()]);
    });
    it("filters the platform's list by approval status", async () => {
        const reader: TestCaller = {...admin, permissions: allPermissionTags([Company])};
        const res = await request(app).post("/api/platform/companies").set(callerHeader(reader)).send({
            offset: 0, limit: 10,
            filter: {id: "root", operator: "and", groups: [], rules: [{id: "r1", field: "portalApproval.status", operator: "in", value: ["pending"]}]},
        });
        expect([res.status, res.body.error_code, res.body.message]).toEqual([200, undefined, undefined]);
        expect((res.body.data as {name: string}[]).map((row) => row.name)).toEqual(["New Rentals"]);
    });
});
