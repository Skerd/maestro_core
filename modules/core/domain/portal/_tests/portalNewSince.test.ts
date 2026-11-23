import {afterEach, describe, expect, it, vi} from "vitest";

// Marking verified companies reads the database; these tests are about what the sections are asked.
vi.mock("../portalVerified", () => ({markVerifiedCompanies: vi.fn(async () => undefined)}));

import {ObjectId} from "mongodb";
import {newPortalItemsSince, portalItemsByIds} from "../portalNewSince";
import {newSinceClause} from "../portalCatalog";
import {clearPortalProviders, registerPortalProvider} from "../portalProviderRegistry";
import type {PortalNewSinceContext, PortalProvider} from "../portalProvider.types";
import type {PortalCatalogItem} from "armonia/src/modules/core/api/portal/public/portal/portal.dto";

/* D178, P23.7: portal sections may answer "what was listed after a date" (the `newSince` seam, CORE-03). */

const tirana = new ObjectId();
const vlore = new ObjectId();
const since = new Date("2026-11-01T08:00:00Z");

/** A fixture section whose items are `<kind>-<n>`, listed on the day given. */
function fixtureSection(key: string, kinds: string[], listed: Record<string, Date>, options: {answers?: boolean} = {}) {
    const item = (kind: string, id: string): PortalCatalogItem => ({kind, id, title: `${kind} ${id}`, section: key, path: `/${id}`, company: {name: "Co", slug: "co"}});
    const newSince = vi.fn(async (context: PortalNewSinceContext) => {
        const ids = Object.keys(listed)
            .filter((id) => id.startsWith(context.kind))
            .filter((id) => listed[id] > context.since)
            .filter((id) => !context.ids || context.ids.includes(id));
        return {items: ids.slice(0, context.limit).map((id) => item(context.kind, id)), total: ids.length};
    });
    const provider: PortalProvider = {
        key,
        order: 10,
        kinds,
        companyIds: async (scope) => scope.companyId ? [scope.companyId] : [tirana, vlore],
        citiesByCompany: async () => new Map([[tirana.toString(), ["Tirana"]], [vlore.toString(), ["Vlorë"]]]),
        browse: vi.fn(async () => ({items: [], total: 0})),
        ...(options.answers === false ? {} : {newSince}),
    };
    registerPortalProvider(provider);
    return newSince;
}

describe("asking the portal's sections what is new (P23.7)", () => {
    afterEach(() => clearPortalProviders());

    it("asks every kind for items listed after the date, with the search's words and city, and leaves out kinds with nothing new", async () => {
        const shop = fixtureSection("shop", ["product", "service"], {"product-1": new Date("2026-11-02"), "product-2": new Date("2026-10-30"), "service-1": new Date("2026-10-01")});

        const groups = await newPortalItemsSince({}, {query: "  bag ", city: "vlor", priceMin: 10, filters: {brand: "x"}}, since, {languageCode: "de-CH", limit: 6});

        expect(groups).toEqual([{kind: "product", items: [expect.objectContaining({id: "product-1"})], total: 1}]);
        expect(shop).toHaveBeenCalledTimes(2);
        // Over every kind, price and a kind's own filters are not used, as on the home catalog.
        expect(shop).toHaveBeenCalledWith(expect.objectContaining({kind: "product", query: "bag", city: "vlor", since, limit: 6, filters: {}, companyIds: [vlore], languageCode: "de-CH"}));
        expect(shop.mock.calls[0][0].priceMin).toBeUndefined();
    });

    it("passes one kind's price and filters on, inside a company's own site", async () => {
        const shop = fixtureSection("shop", ["product", "service"], {"service-1": new Date("2026-11-03")});

        const groups = await newPortalItemsSince({companyId: tirana}, {kind: "service", priceMax: 50, filters: {category: "seo"}}, since, {languageCode: "en-US", limit: 3});

        expect(groups.map((group) => group.kind)).toEqual(["service"]);
        expect(shop).toHaveBeenCalledTimes(1);
        expect(shop).toHaveBeenCalledWith(expect.objectContaining({scope: {companyId: tirana}, companyIds: [tirana], priceMax: 50, filters: {category: "seo"}}));
    });

    it("skips sections that do not answer, and sections with no company in the city", async () => {
        fixtureSection("tasks", ["task"], {"task-1": new Date("2026-11-05")}, {answers: false});
        const cars = fixtureSection("carRental", ["vehicleCategory"], {"vehicleCategory-1": new Date("2026-11-05")});

        expect(await newPortalItemsSince({}, {city: "Durrës"}, since, {languageCode: "en-US", limit: 6})).toEqual([]);
        expect(cars).not.toHaveBeenCalled();
        expect((await newPortalItemsSince({}, {}, since, {languageCode: "en-US", limit: 6})).map((group) => group.kind)).toEqual(["vehicleCategory"]);
    });

    it("shows kept items as the catalog lists them now, in the person's order, leaving out what is gone or cannot be asked", async () => {
        const shop = fixtureSection("shop", ["product"], {"product-1": new Date("2025-01-01"), "product-2": new Date("2026-11-02")});
        fixtureSection("tasks", ["task"], {"task-1": new Date("2026-11-05")}, {answers: false});

        const items = await portalItemsByIds({}, [
            {kind: "product", itemId: "product-2"},
            {kind: "task", itemId: "task-1"},
            {kind: "product", itemId: "product-gone"},
            {kind: "product", itemId: "product-1"},
        ], "en-US");

        expect(items.map((item) => item.id)).toEqual(["product-2", "product-1"]);
        expect(shop).toHaveBeenCalledTimes(1);
        expect(shop).toHaveBeenCalledWith(expect.objectContaining({kind: "product", ids: ["product-2", "product-gone", "product-1"], since: new Date(0), limit: 3, filters: {}}));
    });

    it("narrows a section's query to rows created after the date and, when named, to those ids", () => {
        const id = new ObjectId();
        expect(newSinceClause({since})).toEqual({createdAt: {$gt: since}});
        expect(newSinceClause({since, ids: [id.toString(), "not-an-id"]})).toEqual({createdAt: {$gt: since}, _id: {$in: [id]}});
    });
});
