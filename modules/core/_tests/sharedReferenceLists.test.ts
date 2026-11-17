import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";

const ids = vi.hoisted(() => ({platform: "64a000000000000000000001", shop: "64a000000000000000000002"}));

// The harness stub, with the caller's company marked as the platform owner when it is the platform, as authMW loads it.
vi.mock("@coreModule/utilities/middlewares/authMW", async () => {
    const {authMWStub} = await import("@coreModule/_tests/httpHarness");
    return {
        default: (scope?: string) => (req: {body: Record<string, any>}, res: unknown, next: () => void) =>
            authMWStub.default(scope)(req, res, () => {
                req.body.company = {...req.body.company, isPlatformOwner: String(req.body.company._id) === ids.platform};
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
import * as countryRoute from "@coreModule/api/auxiliary/private/country";
import * as stateRoute from "@coreModule/api/auxiliary/private/state";
import * as cityRoute from "@coreModule/api/auxiliary/private/city";
import * as currencyRoute from "@coreModule/api/finance/private/currency";
import Company from "@coreModule/database/schemas/company/company";
import Country from "@coreModule/database/schemas/country/country";
import Currency from "@coreModule/database/schemas/currency/currency";
import State from "@coreModule/database/schemas/state/state";
import City from "@coreModule/database/schemas/city/city";

const platform = new ObjectId(ids.platform);
const shop = new ObjectId(ids.shop);
const userId = new ObjectId();
const app = appFor([
    {...countryRoute, basePath: "/api/auxiliary/country"},
    {...stateRoute, basePath: "/api/auxiliary/state"},
    {...cityRoute, basePath: "/api/auxiliary/city"},
    {...currencyRoute, basePath: "/api/finance/currency"},
]);
// Both callers hold every permission: the shop is refused by the platform rule, not by its role (D160).
const permissions = allPermissionTags([Country, State, City, Currency]);
const platformAdmin: TestCaller = {userId: userId.toString(), companyId: platform.toString(), isAdmin: true, permissions};
const shopAdmin: TestCaller = {userId: userId.toString(), companyId: shop.toString(), isAdmin: true, permissions};
const call = (caller: TestCaller, method: "post" | "put" | "patch" | "delete", path: string, body: object = {}) =>
    request(app)[method](path).set(callerHeader(caller)).send(body);

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
    ]);
}));

async function seedCountry(name: string, code: string): Promise<ObjectId> {
    const {insertedId} = await Country.collection.insertOne({name, code, phoneCode: "+355", company: platform, deletedAt: null});
    return insertedId;
}

describe("the platform lists (D160)", () => {
    it("are read and selected by every company: the same rows, owned by the platform", async () => {
        const albania = await seedCountry("Albania", "AL");

        const select = await call(shopAdmin, "post", "/api/auxiliary/country/select", {page: 1, limit: 20});
        expect(select.status).toBe(200);
        expect(JSON.stringify(select.body)).toContain(albania.toString());

        const single = await call(shopAdmin, "post", "/api/auxiliary/country/single", {_id: albania.toString()});
        expect([single.status, single.body.code]).toEqual([200, "AL"]);
    });

    it("are written only inside the platform company (another company's create is a request, requestablePlugin)", async () => {
        const albania = await seedCountry("Albania", "AL");

        const renamed = await call(shopAdmin, "patch", "/api/auxiliary/country", {_id: albania.toString(), name: "Shqipëria"});
        expect([renamed.status, renamed.body.error_code]).toEqual([403, "platform_company_required"]);
        const removed = await call(shopAdmin, "delete", "/api/auxiliary/country", {_id: albania.toString()});
        expect([removed.status, removed.body.error_code]).toEqual([403, "platform_company_required"]);

        const added = await call(platformAdmin, "put", "/api/auxiliary/country", {name: "Kosovo", code: "XK", phoneCode: "+383"});
        expect(added.status).toBe(200);
        expect(await Country.collection.findOne({code: "XK"})).toMatchObject({company: platform, name: "Kosovo"});
    });

    it("keep a row that other records point at", async () => {
        const albania = await seedCountry("Albania", "AL");
        await State.collection.insertOne({name: "Vlorë", code: "12", country: albania, company: platform, deletedAt: null});

        const removal = await call(platformAdmin, "delete", "/api/auxiliary/country", {_id: albania.toString()});
        expect([removal.status, removal.body.error_code]).toEqual([400, "cannot_delete_has_relations"]);
    });
});

// TD-F117: the lists fell back to newest first, so the seeded places read Z→A (Zürich, Zug, Vaud…).
describe("the place lists open sorted by name (UX-12)", () => {
    const names = (body: {data: {name: string}[]}) => body.data.map((row) => row.name);

    it("lists countries, states and cities A→Z whatever order they were stored in", async () => {
        const [switzerland, albania] = await Promise.all([seedCountry("Switzerland", "CH"), seedCountry("Albania", "AL")]);
        await seedCountry("Kosovo", "XK");
        await asCrossTenant("test fixtures", async () => {
            for (const [name, code] of [["Vlorë County", "12"], ["Berat District", "BR"], ["Tirana District", "TR"]]) {
                await State.collection.insertOne({name, code, country: albania, company: platform, deletedAt: null});
            }
            for (const name of ["Vorë", "Durrës", "Tirana"]) {
                await City.collection.insertOne({name, country: albania, company: platform, deletedAt: null});
            }
            await City.collection.insertOne({name: "Zürich", country: switzerland, company: platform, deletedAt: null});
        });

        const countries = await call(shopAdmin, "post", "/api/auxiliary/country", {offset: 0, limit: 20});
        expect(names(countries.body)).toEqual(["Albania", "Kosovo", "Switzerland"]);

        const states = await call(shopAdmin, "post", "/api/auxiliary/state", {offset: 0, limit: 20});
        expect(names(states.body)).toEqual(["Berat District", "Tirana District", "Vlorë County"]);

        const cities = await call(shopAdmin, "post", "/api/auxiliary/city", {offset: 0, limit: 20});
        expect(names(cities.body)).toEqual(["Durrës", "Tirana", "Vorë", "Zürich"]);
    });
});
