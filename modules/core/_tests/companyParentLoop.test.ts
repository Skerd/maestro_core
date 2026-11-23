import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";

/* TD-B263: a company can be neither its own parent nor the child of one of its descendants. */
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";
import mongoose from "mongoose";
import {ObjectId} from "mongodb";
import request from "supertest";

// The harness stub, plus the editor's name the company route puts in its change notification.
vi.mock("@coreModule/utilities/middlewares/authMW", async () => {
    const {authMWStub} = await import("@coreModule/_tests/httpHarness");
    return {
        default: (scope?: string) => (req: {body: Record<string, unknown>}, res: unknown, next: () => void) => {
            req.body.actionUserInfo = {name: "Ada", surname: "Lovelace", username: "ada@example.com"};
            return authMWStub.default(scope)(req, res, next);
        },
    };
});
vi.mock("@coreModule/utilities/middlewares/rateLimiter", () => ({
    rateLimiter: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import {allPermissionTags, appFor, callerHeader, type TestCaller} from "@coreModule/_tests/httpHarness";
import Company from "@coreModule/database/schemas/company/company";
import * as companyRoute from "@coreModule/api/company/private/company";
import {asCrossTenant} from "@coreModule/utilities/endpoints/tenantScope";

const companyId = new ObjectId();
const child = new ObjectId();
const grandchild = new ObjectId();
const other = new ObjectId();
const app = appFor([{basePath: companyRoute.basePath, router: companyRoute.router, module: "core"}]);
let admin: TestCaller;
const stored = () => asCrossTenant("test reads the company row", () => Company.collection.findOne({_id: companyId}));
const edit = (body: Record<string, unknown>) =>
    request(app).patch("/api/company").set(callerHeader(admin)).send({_id: companyId.toString(), ...body});
// Raw inserts: saving a new Company seeds its roles, bot and jobs, which these tests do not need.
const row = (_id: ObjectId, name: string, parentCompany?: ObjectId) =>
    ({_id, company: _id, name, siteSlug: name.toLowerCase(), allowedDomains: ["*"], isActive: true, deletedAt: null, ...(parentCompany ? {parentCompany} : {})});

beforeAll(async () => {
    await connectTestDatabase();
    // Every registered model (audit log…): an index still building aborts a transaction that touches it.
    await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
    admin = {userId: new ObjectId().toString(), companyId: companyId.toString(), isAdmin: true, permissions: allPermissionTags([Company]), modules: ["core"]};
}, 120000);

afterAll(async () => {
    await disconnectTestDatabase();
});

beforeEach(async () => {
    await Company.collection.deleteMany({});
    // companyId → child → grandchild, and an unrelated company.
    await Company.collection.insertMany([row(companyId, "Group"), row(child, "Child", companyId), row(grandchild, "Grandchild", child), row(other, "Other")]);
});

describe("Company PATCH parentCompany (TD-B263)", {timeout: 30000}, () => {
    it("refuses the company itself as its parent", async () => {
        const res = await edit({parentCompany: companyId.toString()});
        expect(res.body.error_code).toBe("parent_company_loop");
        expect((await stored())!.parentCompany).toBeUndefined();
    });

    it("refuses one of its own descendants, however deep", async () => {
        expect((await edit({parentCompany: child.toString()})).body.error_code).toBe("parent_company_loop");
        expect((await edit({parentCompany: grandchild.toString()})).body.error_code).toBe("parent_company_loop");
        expect((await stored())!.parentCompany).toBeUndefined();
    });

    it("still accepts a company outside its own tree", async () => {
        const res = await edit({parentCompany: other.toString()});
        expect(res.body.error_code ?? "ok").toBe("ok");
        expect(String((await stored())!.parentCompany)).toBe(other.toString());
    });
});
