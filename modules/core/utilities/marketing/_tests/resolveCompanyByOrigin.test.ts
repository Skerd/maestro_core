import {beforeEach, describe, expect, it, vi} from "vitest";

/* D18: a public request whose origin matches no company fails closed, except on a developer's machine. */

const companies = vi.hoisted(() => ({
    byDomain: new Map<string, {_id: string; name: string}>(),
    wildcard: null as {_id: string; name: string} | null,
}));

vi.mock("@coreModule/database/schemas/company/company.service", () => ({
    companyService: {
        findOne: vi.fn(async (query: {allowedDomains: string}) =>
            query.allowedDomains === "*" ? companies.wildcard : companies.byDomain.get(query.allowedDomains) ?? null),
    },
}));
vi.mock("@coreModule/utilities/marketing/portalCompanies", () => ({
    findPlatformCompany: vi.fn(async () => ({_id: "platform", name: "Platform"})),
    findPortalSiteCompany: vi.fn(async (slug: string) => ({_id: `site-${slug}`, name: slug})),
}));
vi.mock("@coreModule/utilities/modules/companyModules", () => ({assertModuleEnabledForCompany: vi.fn()}));
vi.mock("@coreModule/environment", () => ({PORTAL_ROOT_DOMAIN: "arpeggio.al", CONSTANTS: {DEFAULT_LANGUAGE: "en-US"}}));

import {resolveCompanyByOrigin} from "../resolveCompanyByOrigin";
import {isLocalDevOrigin} from "../portalOrigin";

describe("resolveCompanyByOrigin", () => {
    beforeEach(() => {
        companies.byDomain = new Map([["pronix.al", {_id: "pronix", name: "Pronix"}]]);
        companies.wildcard = {_id: "platform", name: "Platform"};
    });

    it("serves the platform on the portal apex", async () => {
        expect((await resolveCompanyByOrigin("arpeggio.al", "en-US"))._id).toBe("platform");
    });

    it("serves a company site on its portal subdomain", async () => {
        expect((await resolveCompanyByOrigin("dentalab.arpeggio.al", "en-US"))._id).toBe("site-dentalab");
    });

    it("serves a company on its own domain", async () => {
        expect((await resolveCompanyByOrigin("pronix.al", "en-US"))._id).toBe("pronix");
    });

    it("refuses an origin no company owns, even with a wildcard company", async () => {
        await expect(resolveCompanyByOrigin("evil.example", "en-US")).rejects.toMatchObject({
            error_code: "company_not_found_for_origin",
            status: 404,
        });
    });

    it("still falls back to the wildcard company on a developer's machine", async () => {
        expect((await resolveCompanyByOrigin("localhost", "en-US"))._id).toBe("platform");
        expect((await resolveCompanyByOrigin("store.localhost", "en-US"))._id).toBe("platform");
    });

    it("refuses a local origin too when no wildcard company exists", async () => {
        companies.wildcard = null;
        await expect(resolveCompanyByOrigin("localhost", "en-US")).rejects.toMatchObject({error_code: "company_not_found_for_origin"});
    });
});

describe("isLocalDevOrigin", () => {
    it("accepts localhost, its subdomains and loopback", () => {
        for (const origin of ["localhost", "http://localhost:5173", "rental.localhost", "127.0.0.1"]) {
            expect(isLocalDevOrigin(origin)).toBe(true);
        }
    });

    it("rejects real hosts, including look-alikes", () => {
        for (const origin of ["arpeggio.al", "localhost.evil.com", "notlocalhost", "10.0.0.5"]) {
            expect(isLocalDevOrigin(origin)).toBe(false);
        }
    });
});
