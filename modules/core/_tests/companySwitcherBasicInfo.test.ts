import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";
import mongoose from "mongoose";
import {ObjectId} from "mongodb";
import request from "supertest";

const current = new ObjectId();
const other = new ObjectId();
const stranger = new ObjectId();

// The harness stub, plus the caller's memberships the switcher list reads (the stub sets no `actionUserInfo`).
vi.mock("@coreModule/utilities/middlewares/authMW", async () => {
    const {authMWStub} = await import("@coreModule/_tests/httpHarness");
    return {
        default: (scope?: string) => (req: {body: Record<string, unknown>}, res: unknown, next: () => void) => {
            req.body.actionUserInfo = {
                roles: [current, other].map((id) => ({company: {_id: id}, active: "active", lockedOutUntil: null})),
                isAdmin: async () => false,
            };
            return authMWStub.default(scope)(req, res, next);
        },
    };
});
vi.mock("@coreModule/utilities/middlewares/rateLimiter", () => ({
    rateLimiter: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import {appFor, callerHeader, type TestCaller} from "@coreModule/_tests/httpHarness";
import Company from "@coreModule/database/schemas/company/company";
import * as companyRoute from "@coreModule/api/company/private/company";
import * as companiesRoute from "@coreModule/api/company/private/companies";

const app = appFor([
    {basePath: companyRoute.basePath, router: companyRoute.router, module: "core"},
    {basePath: companiesRoute.basePath, router: companiesRoute.router, module: "core"},
]);
// A member whose role grants nothing on the Company model, like a PD Manager who also belongs to a second company.
const member: TestCaller = {userId: new ObjectId().toString(), companyId: current.toString(), isAdmin: false, permissions: [], modules: ["core"]};
const seed = (_id: ObjectId, name: string) =>
    // Raw insert: saving a new Company seeds its roles, bot and jobs, which these tests do not need.
    Company.collection.insertOne({_id, company: _id, name, description: `${name} description`, vat: name, allowedDomains: ["*"], isActive: true, deletedAt: null});

beforeAll(async () => {
    await connectTestDatabase();
    await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
}, 120000);

afterAll(async () => {
    await disconnectTestDatabase();
});

beforeEach(async () => {
    await Company.collection.deleteMany({});
    await Promise.all([seed(current, "Estates"), seed(other, "Alpine Reach"), seed(stranger, "Someone Else")]);
});

describe("Company switcher basic info for members without Company read", {timeout: 30000}, () => {
    it("returns the current company's name, description and logo", async () => {
        const res = await request(app).get("/api/company/basicInfo").set(callerHeader(member));

        expect(res.body.error_code ?? "ok").toBe("ok");
        expect(res.body.name).toBe("Estates");
        expect(res.body.description).toBe("Estates description");
    });

    it("lists only the caller's own companies, with their names", async () => {
        const res = await request(app).post("/api/companies/basicInfo").set(callerHeader(member)).send({offset: 0, limit: 10});

        expect(res.body.error_code ?? "ok").toBe("ok");
        const names = (res.body.data as {name: string}[]).map((company) => company.name).sort();
        expect(names).toEqual(["Alpine Reach", "Estates"]);
        expect(res.body.total).toBe(2);
    });

    it("still refuses the full company record without Company read", async () => {
        const res = await request(app).get("/api/company").set(callerHeader(member));

        expect(res.status).toBe(403);
    });
});
