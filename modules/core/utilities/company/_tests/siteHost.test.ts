import {describe, expect, it} from "vitest";
import {buildSiteHostAssignment, siteHostForSlug} from "../siteHost";

describe("siteHostForSlug", () => {
    it("joins the slug to the zone", () => {
        expect(siteHostForSlug("acme", "arpeggio.al")).toBe("acme.arpeggio.al");
    });
});

describe("buildSiteHostAssignment", () => {
    it("marks domain failed when the zone is missing", () => {
        const assignment = buildSiteHostAssignment({siteSlug: "acme", rootDomain: ""});
        expect(assignment.siteHost).toBeUndefined();
        expect(assignment.siteProvision).toEqual({
            status: "failed",
            lastError: "PORTAL_ROOT_DOMAIN is not set",
            steps: {slug: true, domain: false, reachable: false},
        });
    });

    it("assigns the host and leaves reachable pending", () => {
        expect(buildSiteHostAssignment({siteSlug: "acme", rootDomain: "Arpeggio.al"})).toEqual({
            siteSlug: "acme",
            siteHost: "acme.arpeggio.al",
            siteProvision: {
                status: "pending",
                lastError: "",
                steps: {slug: true, domain: true, reachable: false},
            },
        });
    });
});
