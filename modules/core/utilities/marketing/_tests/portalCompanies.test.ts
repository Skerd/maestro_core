import {describe, expect, it, vi} from "vitest";
import {ObjectId} from "mongodb";

vi.mock("@coreModule/environment", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@coreModule/environment")>();
    return {...actual, clientHostFor: (appId: string) => (appId === "portal" ? "http://portal.example.test:5212" : "http://panel.example.test:5211")};
});

import {companySiteUrl, portalAccountUrl} from "../portalCompanies";

describe("portal URLs in emails", () => {
    it("names a company's own site by its slug, else its id, keeping the scheme and port", () => {
        const id = new ObjectId();
        expect(companySiteUrl({_id: id, siteSlug: "rental"}, "/car-rental/manage")).toBe("http://rental.portal.example.test:5212/car-rental/manage");
        expect(companySiteUrl({_id: id}, "/")).toBe(`http://${id.toString()}.portal.example.test:5212/`);
    });

    it("sends a person to their account on the apex, never to a company site (D178)", () => {
        expect(portalAccountUrl()).toBe("http://portal.example.test:5212/account");
    });
});
