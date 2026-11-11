import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";
import {ObjectId} from "mongodb";
import request from "supertest";

vi.mock("@coreModule/utilities/middlewares/authMW", async () =>
    (await import("@coreModule/_tests/httpHarness")).authMWStub);
vi.mock("@coreModule/utilities/middlewares/rateLimiter", () => ({
    rateLimiter: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import {appFor, callerHeader} from "@coreModule/_tests/httpHarness";
import * as placesRoute from "@coreModule/api/portal/public/portalPlaces";
import Company from "@coreModule/database/schemas/company/company";
import Country from "@coreModule/database/schemas/country/country";
import State from "@coreModule/database/schemas/state/state";
import City from "@coreModule/database/schemas/city/city";
import {asCrossTenant} from "@coreModule/utilities/endpoints/tenantScope";
import {PORTAL_ROOT_DOMAIN} from "@coreModule/environment";

const app = appFor([{...placesRoute, module: "core"}]);
const platform = new ObjectId();
const other = new ObjectId();
const apex = `http://${PORTAL_ROOT_DOMAIN}:5212`;
/** A signed-out visitor on the apex. */
const visitor = () => ({...callerHeader({userId: new ObjectId().toString(), companyId: platform.toString()}), Origin: apex});

beforeAll(async () => {
    await connectTestDatabase();
}, 120000);

afterAll(async () => {
    await disconnectTestDatabase();
});

beforeEach(() => asCrossTenant("test setup", async () => {
    await Promise.all([Company, Country, State, City].map((model) => model.collection.deleteMany({})));
    await Company.collection.insertOne({_id: platform, name: "Platform", vat: "VAT-P", isActive: true, modules: ["core"], isPlatformOwner: true, isDefaultForSignUp: true, deletedAt: null});
}));

describe("portal address places (D142)", () => {
    it("lists the host company's countries, and a country's states and cities, to a visitor with no account", async () => {
        const {albania, otherAlbania} = await asCrossTenant("test setup", async () => {
            const albania = (await Country.collection.insertOne({name: "Albania", code: "AL", phoneCode: "355", company: platform, deletedAt: null})).insertedId;
            const otherAlbania = (await Country.collection.insertOne({name: "Albania", code: "AL", phoneCode: "355", company: other, deletedAt: null})).insertedId;
            await State.collection.insertOne({name: "Tirana District", code: "TR", country: albania, company: platform, deletedAt: null});
            await City.collection.insertMany([
                {name: "Tirana", country: albania, company: platform, deletedAt: null},
                {name: "Durres", country: albania, company: platform, deletedAt: null},
            ]);
            return {albania, otherAlbania};
        });

        const countries = await request(app).get("/api/portal/places/countries").set(visitor());
        const states = await request(app).post("/api/portal/places/states").set(visitor()).send({countryId: albania.toString()});
        const cities = await request(app).post("/api/portal/places/cities").set(visitor()).send({countryId: albania.toString()});

        expect(countries.body.data).toEqual([{_id: albania.toString(), name: "Albania", code: "AL"}]);
        expect(countries.body.data.map((row: {_id: string}) => row._id)).not.toContain(otherAlbania.toString());
        expect(states.body.data.map((row: {name: string}) => row.name)).toEqual(["Tirana District"]);
        expect(cities.body.data.map((row: {name: string}) => row.name)).toEqual(["Durres", "Tirana"]);
    });

    it("refuses a country that is not an id", async () => {
        const res = await request(app).post("/api/portal/places/cities").set(visitor()).send({countryId: "nope"});
        expect(res.status).toBe(400);
    });
});
