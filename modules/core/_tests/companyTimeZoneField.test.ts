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
    // Raw insert: saving a new Company seeds its roles, bot and jobs, which these tests do not need.
    await Company.collection.insertOne({_id: companyId, company: companyId, name: "Lakeside Bakery", siteSlug: "lakeside-bakery", vat: "TZ-1", allowedDomains: ["*"], isActive: true, deletedAt: null});
});

describe("Company.timezone (D91)", {timeout: 30000}, () => {
    it("stores the company's IANA zone, trimmed", async () => {
        const res = await edit({timezone: " Europe/Zurich "});

        expect(res.body.error_code ?? "ok").toBe("ok");
        expect((await stored())!.timezone).toBe("Europe/Zurich");
    });

    it("refuses a zone that does not exist and keeps the one stored", async () => {
        await edit({timezone: "Europe/Tirane"});

        const res = await edit({timezone: "Europe/Atlantis"});

        expect(res.body).toMatchObject({error_code: "company_invalid_timezone", message: "\"Europe/Atlantis\" is not a valid time zone (for example Europe/Zurich)."});
        expect((await stored())!.timezone).toBe("Europe/Tirane");
    });

    it("clears the zone when sent empty, so the instance's zone applies again", async () => {
        await edit({timezone: "Europe/Tirane"});

        expect((await edit({timezone: ""})).body.error_code ?? "ok").toBe("ok");
        expect((await stored())!.timezone).toBeUndefined();
    });
});
