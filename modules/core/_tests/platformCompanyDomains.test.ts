import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";
import mongoose from "mongoose";
import {ObjectId} from "mongodb";
import request from "supertest";

const ids = vi.hoisted(() => ({platform: "64c000000000000000000001"}));

// The harness stub, with the caller's company marked as the platform owner when it is the platform, as authMW loads it,
// plus the editor's name the company route puts in its change notification.
vi.mock("@coreModule/utilities/middlewares/authMW", async () => {
    const {authMWStub} = await import("@coreModule/_tests/httpHarness");
    return {
        default: (scope?: string) => (req: {body: Record<string, any>}, res: unknown, next: () => void) => {
            req.body.actionUserInfo = {name: "Ada", surname: "Lovelace", username: "ada@example.com"};
            return authMWStub.default(scope)(req, res, () => {
                req.body.company = {...req.body.company, isPlatformOwner: String(req.body.company._id) === ids.platform};
                next();
            });
        },
    };
});
vi.mock("@coreModule/utilities/middlewares/rateLimiter", () => ({
    rateLimiter: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import {allPermissionTags, appFor, callerHeader, type TestCaller} from "@coreModule/_tests/httpHarness";
import Company from "@coreModule/database/schemas/company/company";
import {router as platformCompanies} from "@coreModule/api/platform/private/companies";
import * as companyRoute from "@coreModule/api/company/private/company";
import {asCrossTenant} from "@coreModule/utilities/endpoints/tenantScope";

/* D189: only the platform sets a company's own domains, and a domain belongs to one company. */

const platform = new ObjectId(ids.platform);
const rentals = new ObjectId();
const shop = new ObjectId();
const app = appFor([
    {basePath: "/api/platform/companies", router: platformCompanies, module: "core"},
    {basePath: companyRoute.basePath, router: companyRoute.router, module: "core"},
]);
let platformAdmin: TestCaller;
let platformStaff: TestCaller;
let shopAdmin: TestCaller;
const domainsOf = async (id: ObjectId) =>
    (await asCrossTenant("test reads the company row", () => Company.collection.findOne({_id: id})))!.allowedDomains;
const setDomains = (caller: TestCaller, id: ObjectId, allowedDomains: string[]) =>
    request(app).put(`/api/platform/companies/domains/${id.toString()}`).set(callerHeader(caller)).send({allowedDomains});

beforeAll(async () => {
    await connectTestDatabase();
    await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
    platformAdmin = {userId: new ObjectId().toString(), companyId: platform.toString(), isAdmin: true, modules: ["core"]};
    platformStaff = {userId: new ObjectId().toString(), companyId: platform.toString(), isAdmin: false, modules: ["core"]};
    shopAdmin = {userId: new ObjectId().toString(), companyId: shop.toString(), isAdmin: true, permissions: allPermissionTags([Company]), modules: ["core"]};
}, 120000);

afterAll(async () => {
    await disconnectTestDatabase();
});

beforeEach(() => asCrossTenant("test fixtures span companies", async () => {
    for (const collection of await mongoose.connection.db!.collections()) await collection.deleteMany({});
    await Company.collection.insertMany([
        {_id: platform, company: platform, name: "Platform", vat: "P-1", isPlatformOwner: true, allowedDomains: ["*"], isActive: true, modules: ["core"], deletedAt: null},
        {_id: rentals, company: platform, name: "Rent A", vat: "R-1", siteSlug: "rent-a", allowedDomains: ["none.none.com"], isActive: true, modules: ["core"], deletedAt: null},
        {_id: shop, company: platform, name: "Shop", vat: "S-1", siteSlug: "shop-bern", allowedDomains: ["none.none.com"], isActive: true, modules: ["core"], deletedAt: null},
    ]);
}));

describe("a company's own domains (D189)", {timeout: 60000}, () => {
    it("are set by a platform admin, stored the way requests are matched", async () => {
        const res = await setDomains(platformAdmin, rentals, ["https://Rent-A.al/", "rent-a.al", " www.rent-a.al "]);

        expect([res.status, res.body.error_code]).toEqual([200, undefined]);
        expect(await domainsOf(rentals)).toEqual(["rent-a.al", "www.rent-a.al"]);
    });

    it("belong to one company: another company cannot take a domain already held", async () => {
        await setDomains(platformAdmin, rentals, ["rent-a.al"]);

        const res = await setDomains(platformAdmin, shop, ["shop.ch", "RENT-A.AL"]);

        expect(res.body.error_code).toBe("company_domain_taken");
        expect(await domainsOf(shop)).toEqual(["none.none.com"]);
    });

    it("may share a host the platform serves itself", async () => {
        expect((await setDomains(platformAdmin, rentals, ["localhost"])).body.error_code).toBeUndefined();
        expect((await setDomains(platformAdmin, shop, ["localhost"])).body.error_code).toBeUndefined();
        expect(await domainsOf(shop)).toEqual(["localhost"]);
    });

    it("refuse a value that is not a host name, and an empty list leaves only the portal address", async () => {
        expect((await setDomains(platformAdmin, rentals, ["rent a .al"])).body.error_code).toBe("company_domain_invalid");

        expect((await setDomains(platformAdmin, rentals, [])).body.error_code).toBeUndefined();
        expect(await domainsOf(rentals)).toEqual(["none.none.com"]);
    });

    it("cannot be set by anyone but a platform admin", async () => {
        expect((await setDomains(platformStaff, rentals, ["rent-a.al"])).body.error_code).toBe("platform_admin_required");
        expect((await setDomains(shopAdmin, shop, ["shop.ch"])).body.error_code).toBe("platform_admin_required");
        expect(await domainsOf(shop)).toEqual(["none.none.com"]);
    });

    it("cannot be claimed by a company through its own settings", async () => {
        await setDomains(platformAdmin, rentals, ["rent-a.al"]);

        const res = await request(app).patch("/api/company").set(callerHeader(shopAdmin))
            .send({_id: shop.toString(), allowedDomains: ["rent-a.al"], vat: "S-2"});

        expect(res.body.error_code ?? "ok").toBe("ok");
        expect(await domainsOf(shop)).toEqual(["none.none.com"]);
    });
});
