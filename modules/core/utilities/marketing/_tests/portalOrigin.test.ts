import {afterEach, describe, expect, it, vi} from "vitest";
import {isPortalApexOrigin, isPortalZoneOrigin, normalizeOriginHost, portalSiteSlug} from "../portalOrigin";

const ROOT = "arpeggio.al";

describe("portalOrigin", () => {
    afterEach(() => {
        vi.resetModules();
        vi.unstubAllEnvs();
    });

    it("normalizes origins, referers and hostnames to a bare host", () => {
        expect(normalizeOriginHost("https://Arpeggio.al/path")).toBe("arpeggio.al");
        expect(normalizeOriginHost("arpeggio.al:443")).toBe("arpeggio.al");
        expect(normalizeOriginHost("")).toBe("");
    });

    it("recognises the apex and its www", () => {
        expect(isPortalApexOrigin("https://arpeggio.al", ROOT)).toBe(true);
        expect(isPortalApexOrigin("https://www.arpeggio.al", ROOT)).toBe(true);
        expect(isPortalApexOrigin("https://dentalab.arpeggio.al", ROOT)).toBe(false);
        expect(portalSiteSlug("https://www.arpeggio.al", ROOT)).toBeNull();
    });

    it("reads the company from a one-label subdomain, with or without a port", () => {
        expect(portalSiteSlug("https://dentalab.arpeggio.al", ROOT)).toBe("dentalab");
        expect(portalSiteSlug("http://rental.portal.localhost:5212", "portal.localhost")).toBe("rental");
        expect(isPortalZoneOrigin("https://dentalab.arpeggio.al/book", ROOT)).toBe(true);
    });

    it("keeps reserved labels, deeper subdomains and other hosts out of the zone", () => {
        expect(portalSiteSlug("https://panel.arpeggio.al", ROOT)).toBeNull();
        expect(isPortalZoneOrigin("https://panel.arpeggio.al", ROOT)).toBe(false);
        expect(portalSiteSlug("https://a.b.arpeggio.al", ROOT)).toBeNull();
        expect(isPortalZoneOrigin("https://notarpeggio.al", ROOT)).toBe(false);
        expect(isPortalZoneOrigin("https://pronix.al", ROOT)).toBe(false);
    });

    it("has no zone when PORTAL_ROOT_DOMAIN is empty", async () => {
        vi.stubEnv("PORTAL_ROOT_DOMAIN", "");
        const origin = await import("../portalOrigin");
        expect(origin.isPortalZoneOrigin("http://localhost:5212")).toBe(false);
        expect(origin.portalSiteSlug("http://store.localhost:5212")).toBeNull();
    });
});
