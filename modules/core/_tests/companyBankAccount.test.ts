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

/* D190: a company's own bank account, where customers pay it by bank transfer while card payments are off. */

const companyId = new ObjectId();
const app = appFor([{basePath: companyRoute.basePath, router: companyRoute.router, module: "core"}]);
let admin: TestCaller;
const stored = () => asCrossTenant("test reads the company row", () => Company.collection.findOne({_id: companyId}));
const edit = (body: Record<string, unknown>) =>
    request(app).patch("/api/company").set(callerHeader(admin)).send({_id: companyId.toString(), ...body});

beforeAll(async () => {
    await connectTestDatabase();
    await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
    admin = {userId: new ObjectId().toString(), companyId: companyId.toString(), isAdmin: true, permissions: allPermissionTags([Company]), modules: ["core"]};
}, 120000);

afterAll(async () => {
    await disconnectTestDatabase();
});

beforeEach(async () => {
    await Company.collection.deleteMany({});
    // Raw insert: saving a new Company seeds its roles, bot and jobs, which these tests do not need.
    await Company.collection.insertOne({_id: companyId, company: companyId, name: "Shop", vat: "TZ-1", siteSlug: "shop-bern", allowedDomains: ["*"], isActive: true, deletedAt: null});
});

describe("a company's bank account (D190)", {timeout: 30000}, () => {
    it("is stored with the IBAN without spaces and the BIC in capitals", async () => {
        const res = await edit({bankAccount: {holder: " Shop sh.p.k. ", iban: "al47 2121 1009 0000 0002 3569 8741", bic: "bktr altr", bankName: "BKT"}});

        expect(res.body.error_code ?? "ok").toBe("ok");
        expect((await stored())!.bankAccount).toEqual({holder: "Shop sh.p.k.", iban: "AL47212110090000000235698741", bic: "BKTRALTR", bankName: "BKT"});
    });

    it("refuses an IBAN whose check digits are wrong", async () => {
        const res = await edit({bankAccount: {iban: "AL47 2121 1009 0000 0002 3569 8742"}});

        expect(res.status).toBe(400);
        expect((await stored())!.bankAccount).toBeUndefined();
    });

    it("is removed when the form is cleared", async () => {
        await edit({bankAccount: {holder: "Shop", iban: "AL47212110090000000235698741"}});

        const res = await edit({bankAccount: {holder: "", iban: "", bic: "", bankName: ""}});

        expect(res.body.error_code ?? "ok").toBe("ok");
        expect((await stored())!.bankAccount).toBeUndefined();
    });
});
