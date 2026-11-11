import {describe, expect, it} from "vitest";
import {ObjectId} from "mongodb";
import {samePriceCurrencyCompanies} from "@coreModule/domain/portal/portalCatalog";

const [eurA, eurB, chf, unpriced] = [new ObjectId(), new ObjectId(), new ObjectId(), new ObjectId()];
const companies = [eurA, eurB, chf, unpriced];
const currencies = new Map([[eurA.toString(), "EUR"], [eurB.toString(), "EUR"], [chf.toString(), "CHF"]]);

describe("comparing portal prices (P8.8)", () => {
    it("keeps every company when no price filter or price sort is used", () => {
        expect(samePriceCurrencyCompanies(companies, currencies, {sort: "newest", filters: {}})).toEqual(companies);
    });

    it("compares prices only within the currency most companies use", () => {
        expect(samePriceCurrencyCompanies(companies, currencies, {priceMax: 100, filters: {}})).toEqual([eurA, eurB]);
        expect(samePriceCurrencyCompanies(companies, currencies, {sort: "priceAsc", filters: {}})).toEqual([eurA, eurB]);
    });

    it("compares prices in the currency the visitor picked", () => {
        expect(samePriceCurrencyCompanies(companies, currencies, {sort: "priceDesc", filters: {currency: "chf"}})).toEqual([chf]);
    });
});
