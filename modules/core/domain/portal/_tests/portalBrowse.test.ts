import {afterEach, describe, expect, it, vi} from "vitest";
import {ObjectId} from "mongodb";
import {browsePortal} from "../portalBrowse";
import {clearPortalProviders, registerPortalProvider} from "../portalProviderRegistry";
import type {PortalBrowseParams, PortalProvider} from "../portalProvider.types";
import {fixtureSectionNames} from "@coreModule/domain/portal/_tests/fixtureSectionNames";

const tirana = new ObjectId();
const vlore = new ObjectId();

function fakeProvider(key: string, kinds: string[], order: number) {
    const browse = vi.fn(async (params: PortalBrowseParams) => ({
        items: params.companyIds.map((id) => ({
            kind: params.kind, id: id.toString(), title: `${params.kind} of ${id}`, section: key, path: "", company: {name: "Co", slug: "co"},
        })),
        total: params.companyIds.length,
    }));
    const provider: PortalProvider = {
        key,
        order,
        ...fixtureSectionNames(key),
        kinds,
        companyIds: async (scope) => scope.companyId ? [scope.companyId] : [tirana, vlore],
        citiesByCompany: async () => new Map([[tirana.toString(), ["Tirana"]], [vlore.toString(), ["Vlorë"]]]),
        browse,
    };
    registerPortalProvider(provider);
    return browse;
}

describe("browsePortal", () => {
    afterEach(() => clearPortalProviders());

    it("shows a few of every kind when no kind is asked for, and leaves empty kinds out", async () => {
        const shop = fakeProvider("shop", ["product", "service"], 10);
        fakeProvider("empty", ["nothing"], 20).mockResolvedValue({items: [], total: 0});

        const groups = await browsePortal({}, {query: "  bag ", priceMin: 10, filters: {brand: "x"}}, "en-US");

        expect(groups.map((group) => group.kind)).toEqual(["product", "service"]);
        expect(shop).toHaveBeenCalledWith(expect.objectContaining({kind: "product", query: "bag", skip: 0, limit: 8, filters: {}}));
        expect(shop.mock.calls[0][0].priceMin).toBeUndefined();
    });

    it("pages one kind with every filter", async () => {
        const shop = fakeProvider("shop", ["product", "service"], 10);

        const [group] = await browsePortal({}, {kind: "service", page: 3, limit: 5, sort: "priceAsc", filters: {category: "seo"}}, "en-US");

        expect(group.kind).toBe("service");
        expect(shop).toHaveBeenCalledTimes(1);
        expect(shop).toHaveBeenCalledWith(expect.objectContaining({kind: "service", skip: 10, limit: 5, sort: "priceAsc", filters: {category: "seo"}}));
    });

    it("narrows the companies to the city", async () => {
        const shop = fakeProvider("shop", ["product"], 10);

        await browsePortal({}, {kind: "product", city: "vlor"}, "en-US");

        expect(shop.mock.calls[0][0].companyIds).toEqual([vlore]);
    });

    it("keeps a company's own site to that company", async () => {
        const shop = fakeProvider("shop", ["product"], 10);

        await browsePortal({companyId: tirana}, {kind: "product"}, "en-US");

        expect(shop.mock.calls[0][0]).toEqual(expect.objectContaining({scope: {companyId: tirana}, companyIds: [tirana]}));
    });

    it("refuses a kind no section lists", async () => {
        fakeProvider("shop", ["product"], 10);
        await expect(browsePortal({}, {kind: "spaceship"}, "en-US")).rejects.toThrow();
    });
});
