/**
 * TD-B241: Albania's cities came three times ("Durrës", "Bashkia Durrës", "Durrës District"), and the demo companies'
 * addresses had a city but no state.
 */
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import mongoose from "mongoose";
import {ObjectId} from "mongodb";
import {City as CityList} from "country-state-city";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";
import {withTenant} from "@coreModule/utilities/endpoints/tenantScope";
import Company from "@coreModule/database/schemas/company/company";
import {isSeededCity} from "@coreModule/database/schemas/city/city.defaults";
import {applyDemoAddress} from "@coreModule/database/schemas/company/company.defaults";

describe("seeded cities", () => {
    it("keeps one row per Albanian city, without its municipality and district", () => {
        const kept = CityList.getCitiesOfCountry("AL")!.filter((city) => isSeededCity("AL", city.name)).map((city) => city.name);

        expect(kept).toEqual(expect.arrayContaining(["Durrës", "Vorë", "Tirana", "Klos"]));
        expect(kept.filter((name) => /Bashkia|Rrethi|District/.test(name))).toEqual([]);
        expect(new Set(kept).size).toBe(kept.length);
    });

    it("leaves other countries' data alone", () => {
        expect(isSeededCity("IN", "Mumbai Suburban District")).toBe(true);
    });
});

describe("demo company address", () => {
    const companyId = new ObjectId();
    const db = () => mongoose.connection.db!;

    beforeAll(async () => {
        await connectTestDatabase();
    }, 120000);

    afterAll(async () => {
        await disconnectTestDatabase();
    });

    it("carries the state of its city", () => withTenant(companyId, async () => {
        const [country, state, city] = [new ObjectId(), new ObjectId(), new ObjectId()];
        await db().collection("countries").insertOne({_id: country, company: companyId, code: "AL", name: "Albania"});
        await db().collection("cities").insertOne({_id: city, company: companyId, country, state, name: "Tirana"});
        await db().collection("companies").insertOne({_id: companyId, company: companyId, name: "Kudoo Market", vat: "KM", deletedAt: null});

        await applyDemoAddress(await Company.findById(companyId), {
            countryCode: "AL", cityName: "Tirana", street: "Rruga Myslym Shyri 26", postalCode: "1001",
            geoLocation: {latitude: 41.3234, longitude: 19.8182},
        });

        const [address] = (await db().collection("companies").findOne({_id: companyId}))!.addresses;
        expect([String(address.country), String(address.state), String(address.city)]).toEqual([String(country), String(state), String(city)]);
    }));
});
