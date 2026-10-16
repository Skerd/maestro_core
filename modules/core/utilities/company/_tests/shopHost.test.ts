import {describe, expect, it} from "vitest";
import {buildShopHostAssignment, mergeShopAllowedDomains, shopHostForSlug} from "../shopHost";

describe("shopHostForSlug", () => {
    it("joins the slug to the zone", () => {
        expect(shopHostForSlug("acme", "arpeggio.al")).toBe("acme.arpeggio.al");
    });
});

describe("mergeShopAllowedDomains", () => {
    it("replaces the previous shop host and keeps extra domains", () => {
        expect(
            mergeShopAllowedDomains(
                ["Old.arpeggio.al", "custom.example", "acme.arpeggio.al"],
                "acme.arpeggio.al",
                "old.arpeggio.al",
            ),
        ).toEqual(["custom.example", "acme.arpeggio.al"]);
    });
});

describe("buildShopHostAssignment", () => {
    it("marks domain failed when the zone is missing", () => {
        const assignment = buildShopHostAssignment({
            shopSlug: "acme",
            allowedDomains: [],
            rootDomain: "",
        });
        expect(assignment.shopHost).toBeUndefined();
        expect(assignment.shopProvision).toEqual({
            status: "failed",
            lastError: "SHOP_ROOT_DOMAIN is not set",
            steps: {slug: true, domain: false, reachable: false},
        });
    });

    it("assigns the host and leaves reachable pending", () => {
        const assignment = buildShopHostAssignment({
            shopSlug: "acme",
            allowedDomains: ["already.example"],
            rootDomain: "arpeggio.al",
            previousHost: "old.arpeggio.al",
        });
        expect(assignment).toEqual({
            shopSlug: "acme",
            shopHost: "acme.arpeggio.al",
            allowedDomains: ["already.example", "acme.arpeggio.al"],
            shopProvision: {
                status: "pending",
                lastError: "",
                steps: {slug: true, domain: true, reachable: false},
            },
        });
    });
});
