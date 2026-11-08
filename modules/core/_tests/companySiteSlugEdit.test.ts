import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
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
const app = appFor([{basePath: companyRoute.basePath, router: companyRoute.router, module: "core"}]);
let admin: TestCaller;
const stored = () => asCrossTenant("test reads the company row", () => Company.collection.findOne({_id: companyId}));
const edit = (body: Record<string, unknown>) =>
    request(app).patch("/api/company").set(callerHeader(admin)).send({_id: companyId.toString(), ...body});
const seed = (fields: Record<string, unknown>) =>
    // Raw insert: saving a new Company seeds its roles, bot and jobs, which these tests do not need.
    Company.collection.insertOne({_id: companyId, company: companyId, name: "Shop", vat: "TZ-1", allowedDomains: ["*"], isActive: true, deletedAt: null, ...fields});

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
});

describe("Company PATCH siteSlug (TD-B51)", {timeout: 30000}, () => {
    it("keeps the stored slug on an edit that does not send one, even when the name slugifies to a reserved word", async () => {
        await seed({siteSlug: "shop-bern"});

        const res = await edit({vat: "TZ-2"});

        expect(res.body.error_code ?? "ok").toBe("ok");
        const company = await stored();
        expect(company!.vat).toBe("TZ-2");
        expect(company!.siteSlug).toBe("shop-bern");
    });

    it("still refuses a reserved slug the user sends", async () => {
        await seed({siteSlug: "shop-bern"});

        const res = await edit({siteSlug: "shop"});

        expect(res.body.error_code).toBe("company_site_slug_reserved");
        expect((await stored())!.siteSlug).toBe("shop-bern");
    });

    it("builds the slug from the name when none is stored or sent", async () => {
        await seed({name: "Lakeside Bakery"});

        const res = await edit({vat: "TZ-2"});

        expect(res.body.error_code ?? "ok").toBe("ok");
        expect((await stored())!.siteSlug).toBe("lakeside-bakery");
    });
});
