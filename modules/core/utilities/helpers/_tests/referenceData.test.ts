import {afterAll, beforeAll, beforeEach, describe, expect, it} from "vitest";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";

import {ObjectId} from "mongodb";
import Currency from "@coreModule/database/schemas/currency/currency";
import Country from "@coreModule/database/schemas/country/country";
import State from "@coreModule/database/schemas/state/state";
import City from "@coreModule/database/schemas/city/city";
import {asCrossTenant, withTenant} from "@coreModule/utilities/endpoints/tenantScope";
import {sameCurrencyIn, samePlacesIn} from "../referenceData";

const source = new ObjectId();
const target = new ObjectId();
const fixtures = <T>(fn: () => PromiseLike<T>): Promise<T> => asCrossTenant("test fixtures span companies", fn);

/** One company's copy of the reference data, as the seed gives every company. */
async function seedCopy(company: ObjectId, options: {withSecondTown?: boolean} = {}) {
    const euro = new ObjectId();
    const country = new ObjectId();
    const state = new ObjectId();
    const city = new ObjectId();
    await Currency.collection.insertOne({_id: euro, name: "Euro", symbol: "€", abbreviation: "EUR", decimalPlaces: 2, company});
    await Country.collection.insertOne({_id: country, name: "Albania", code: "AL", company});
    await State.collection.insertOne({_id: state, name: "Durrës District", code: "DR", country, company});
    await City.collection.insertOne({_id: city, name: "Durrës", state, country, company});
    if (options.withSecondTown) {
        // Same city name in another state: only the matched state's one may be picked.
        const other = new ObjectId();
        await State.collection.insertOne({_id: other, name: "Elsewhere", code: "EL", country, company});
        await City.collection.insertOne({name: "Durrës", state: other, country, company});
    }
    return {euro, country, state, city};
}

beforeAll(async () => {
    await connectTestDatabase();
}, 120000);

afterAll(async () => {
    await disconnectTestDatabase();
});

beforeEach(() => fixtures(async () => {
    await Promise.all([Currency, Country, State, City].map((model) => model.collection.deleteMany({})));
}));

describe("the same reference data in another company (D143)", () => {
    it("finds the target company's currency by ISO code, from any request tenant", async () => {
        const from = await fixtures(() => seedCopy(source));
        const to = await fixtures(() => seedCopy(target));

        expect(String(await withTenant(source, () => sameCurrencyIn(target, from.euro)))).toBe(to.euro.toString());
        expect(String(await withTenant(source, () => sameCurrencyIn(target, to.euro)))).toBe(to.euro.toString());
        expect(await withTenant(source, () => sameCurrencyIn(target, new ObjectId()))).toBeUndefined();
    });

    it("finds the target company's country, state and city by their keys", async () => {
        const from = await fixtures(() => seedCopy(source));
        const to = await fixtures(() => seedCopy(target, {withSecondTown: true}));

        const places = await withTenant(source, () => samePlacesIn(target, {country: from.country, state: from.state, city: from.city}));
        expect({country: String(places.country), state: String(places.state), city: String(places.city)})
            .toEqual({country: to.country.toString(), state: to.state.toString(), city: to.city.toString()});
    });

    it("leaves out what the target company does not have", async () => {
        const from = await fixtures(() => seedCopy(source));

        expect(await withTenant(source, () => samePlacesIn(target, {country: from.country, city: from.city}))).toEqual({});
        expect(await withTenant(source, () => sameCurrencyIn(target, from.euro))).toBeUndefined();
    });
});
