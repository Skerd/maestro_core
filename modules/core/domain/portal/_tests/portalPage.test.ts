import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {ObjectId} from "mongodb";
import Company from "@coreModule/database/schemas/company/company";
import {getLogger} from "@coreModule/loggers/serverLog";
import type {PortalCatalogItem} from "armonia/src/modules/core/api/portal/public/portal/portal.dto";
import {fixtureSectionNames} from "@coreModule/domain/portal/_tests/fixtureSectionNames";

/* D181: what each portal page says to search engines, from fixture sections only (no module's). */

const host = vi.hoisted(() => ({companyId: undefined as unknown}));
vi.mock("@coreModule/environment", async (importOriginal) => ({...await importOriginal<object>(), PORTAL_SEARCH_INDEXING: true, PORTAL_LANDING_MIN_LISTINGS: 5}));
vi.mock("../portalBrowse", async (importOriginal) => {
    const original = await importOriginal<typeof import("../portalBrowse")>();
    return {
        ...original,
        hostCompany: async () => ({company: host.companyId ? adria : platform, scope: host.companyId ? {companyId: adria._id} : {}}),
        inPortalScope: <T>(_scope: unknown, read: () => Promise<T>) => read(),
    };
});
vi.mock("@coreModule/utilities/marketing/portalCompanies", async (importOriginal) => ({
    ...await importOriginal<object>(),
    findPortalSiteCompany: async (slug: string) => {
        if (slug !== "adria") throw new Error("portal_company_not_listed");
        return adria;
    },
    portalCompanyProfile: async () => ({name: "Adria", logo: "/api/auxiliary/media/logo1", phoneNumber: "+355 69 000", addresses: [{street: "Rruga 1", city: {_id: "c", name: "Tirana"}}]}),
    portalCompanyRefs: async (ids: ObjectId[]) => new Map(ids.filter((id) => id.equals(adria._id)).map((id) => [id.toString(), {name: "Adria", slug: "adria"}])),
}));

import {describePortalPage, type PortalBlogReader} from "../portalPage";
import {isCrawler, renderPortalPage} from "../portalPageHtml";
import {portalRobots, portalSitemap} from "../portalSitemap";
import {clearPortalLandings} from "../portalLandings";
import {clearPortalProviders, registerPortalProvider} from "../portalProviderRegistry";
import type {PortalBrowseParams} from "../portalProvider.types";

const platform = new Company({name: "Kudoo", description: "Everything local."});
const adria = new Company({name: "Adria", siteSlug: "adria", description: "Cars by the sea."});
const vlore = new ObjectId();

function gadget(id: string, extra: Partial<PortalCatalogItem> = {}): PortalCatalogItem {
    return {kind: "gadget", id, title: `Gadget ${id}`, subtitle: "Blue", section: "fixture", path: `/item?id=${id}`, company: {name: "Adria", slug: "adria"}, ...extra};
}

const browse = vi.fn(async (params: PortalBrowseParams) => {
    // Six gadgets in Tirana (enough for a landing page), one in Vlorë.
    const inTirana = params.companyIds.some((id) => id.equals(adria._id));
    const total = inTirana ? 6 : 1;
    return {items: Array.from({length: Math.min(total, params.limit)}, (_, index) => gadget(String(index + 1 + params.skip))), total};
});

const blog: PortalBlogReader = {
    scope: (_origin, read) => read(),
    list: async () => ({posts: [{_id: "p1", title: "Spring <offers>", slug: "spring", content: "", excerpt: "What is new."}], total: 1, categories: []}),
    single: async ({slug}) => {
        if (slug !== "spring") throw new Error("blog_post_not_found");
        return {post: {_id: "p1", title: "Spring offers", slug, content: "", excerpt: "What is new.", publishedAt: "2026-11-01T00:00:00.000Z", authorName: "Ana"}};
    },
};

const page = (path: string) => describePortalPage({host: "portal.test", baseUrl: "https://portal.test", path, languageCode: "en-US", logger: getLogger("test")}, blog);

beforeEach(() => {
    host.companyId = undefined;
    browse.mockClear();
    clearPortalLandings();
    clearPortalProviders();
    registerPortalProvider({
        key: "fixture",
        order: 10,
        ...fixtureSectionNames("fixture"),
        kinds: ["gadget"],
        companyIds: async (scope) => scope.companyId ? [scope.companyId] : [adria._id, vlore],
        citiesByCompany: async () => new Map([[adria._id.toString(), ["Tiranë"]], [vlore.toString(), ["Vlorë"]]]),
        browse,
        itemAt: async ({path}) => path === "/item?id=7" ? {item: gadget("7", {price: {amount: 25, currency: "EUR"}, rating: {average: 4.5, count: 3}}), schemaType: "Product"} : undefined,
    });
});

afterEach(() => {
    clearPortalProviders();
});

describe("describePortalPage (D181)", () => {
    it("titles the apex home with the platform, links its city landing pages and the first items of every section", async () => {
        const home = await page("/");
        // The portal's own line, not the platform company's description (written for its staff).
        expect(home).toMatchObject({title: "Kudoo", description: "Shops, services, car rentals, dentists and homes from local businesses, in one place.", canonical: "https://portal.test/", indexable: true});
        expect(home?.links).toContainEqual({href: "/fixture/in/tirane", text: "Fixture fixture in Tiranë", detail: "6"});
        expect(home?.links.some((link) => link.href === "/fixture/in/vlore")).toBe(false);
        expect(home?.links).toContainEqual(expect.objectContaining({href: "/fixture/adria/item?id=1", text: "Gadget 1"}));
        expect(home?.jsonLd[0]).toMatchObject({"@type": "WebSite", name: "Kudoo"});
    });

    it("lists one kind's catalog, and keeps a search out of search engines", async () => {
        expect(await page("/?kind=gadget")).toMatchObject({title: "Fixture fixture · Kudoo", canonical: "https://portal.test/?kind=gadget", indexable: true});
        expect(await page("/?kind=gadget&q=blue")).toMatchObject({indexable: false});
        expect(await page("/?q=blue")).toMatchObject({indexable: false});
    });

    it("opens a landing page only for a city the apex offers", async () => {
        const landing = await page("/fixture/in/tirane");
        expect(landing).toMatchObject({title: "Fixture fixture in Tiranë · Kudoo", heading: "Fixture fixture in Tiranë", indexable: true});
        expect(landing?.description).toContain("6 listings in Tiranë");
        expect(await page("/fixture/in/vlore")).toMatchObject({indexable: false});
    });

    it("describes a company's site and its item pages, and nothing it cannot place", async () => {
        const site = await page("/fixture/adria");
        expect(site).toMatchObject({title: "Adria · Kudoo", description: "Cars by the sea.", canonical: "https://portal.test/fixture/adria", image: "https://portal.test/api/auxiliary/media/logo1"});
        expect(site?.jsonLd[0]).toMatchObject({"@type": "LocalBusiness", name: "Adria", telephone: "+355 69 000", address: {addressLocality: "Tirana"}});

        const item = await page("/fixture/adria/item?id=7");
        expect(item).toMatchObject({title: "Gadget 7 · Kudoo", type: "product", canonical: "https://portal.test/fixture/adria/item?id=7", indexable: true});
        expect(item?.jsonLd[0]).toMatchObject({"@type": "Product", offers: {price: 25, priceCurrency: "EUR"}, aggregateRating: {ratingValue: 4.5, reviewCount: 3}});

        expect(await page("/fixture/adria/cart")).toMatchObject({title: "Adria · Kudoo", indexable: false});
        expect(await page("/fixture/nobody")).toMatchObject({indexable: false});
    });

    it("keeps private pages and unknown addresses out of search engines", async () => {
        expect(await page("/account/saved")).toMatchObject({indexable: false, title: "Kudoo"});
        expect(await page("/business/new")).toMatchObject({indexable: false});
        expect(await page("/somewhere")).toMatchObject({indexable: false});
        expect(await page("/business")).toMatchObject({title: "Create your free business site · Kudoo", indexable: true});
    });

    it("on a company's own host, addresses its section without the company's slug", async () => {
        host.companyId = adria._id;
        const site = await page("/fixture");
        expect(site).toMatchObject({title: "Adria", canonical: "https://portal.test/fixture"});
        expect(site?.links).toContainEqual(expect.objectContaining({href: "/fixture/item?id=1"}));
        expect(await page("/business")).toMatchObject({indexable: false});
    });

    it("describes the blog and its posts", async () => {
        expect((await page("/blog"))?.links).toEqual([{href: "/blog/spring", text: "Spring <offers>", detail: "What is new."}]);
        const post = await page("/blog/spring");
        expect(post).toMatchObject({title: "Spring offers · Kudoo", type: "article", description: "What is new."});
        expect(post?.jsonLd[0]).toMatchObject({"@type": "BlogPosting", datePublished: "2026-11-01T00:00:00.000Z", author: {name: "Ana"}});
        expect(await page("/blog/gone")).toMatchObject({indexable: false});
    });
});

describe("renderPortalPage (D181)", () => {
    const template = '<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <title>Portal</title>\n  </head>\n  <body>\n    <div id="root"></div>\n  </body>\n</html>';

    it("fills the head, escapes every value, and gives crawlers alone the plain copy", async () => {
        const blogPage = await page("/blog");
        if (!blogPage) throw new Error("no page");
        const evil = {...blogPage, title: "A </title><script>alert(1)</script> $& title", jsonLd: [{name: "</script><script>x()</script>"}]};

        const forPeople = renderPortalPage(template, evil, false);
        expect(forPeople).toContain('<html lang="en-US">');
        expect(forPeople).toContain("<title>A &lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt; $&amp; title</title>");
        expect(forPeople).not.toContain("<script>alert(1)");
        expect(forPeople).toContain("\\u003c/script>\\u003cscript>x()\\u003c/script>");
        expect(forPeople).toContain('<link rel="canonical" href="https://portal.test/blog" />');
        expect(forPeople).toContain('<div id="root"></div>');

        const forCrawlers = renderPortalPage(template, evil, true);
        expect(forCrawlers).toContain('<div id="root"><main data-portal-copy><h1>Blog</h1>');
        expect(forCrawlers).toContain('<a href="/blog/spring">Spring &lt;offers&gt;</a> What is new.');
    });

    it("tells search engines not to list a private page", async () => {
        const account = await page("/account");
        if (!account) throw new Error("no page");
        expect(renderPortalPage(template, account, false)).toContain('<meta name="robots" content="noindex" />');
    });

    it("knows crawlers and link previews from people", () => {
        expect(isCrawler("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)")).toBe(true);
        expect(isCrawler("facebookexternalhit/1.1")).toBe(true);
        expect(isCrawler("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36")).toBe(false);
    });
});

describe("portalRobots and portalSitemap (D181)", () => {
    it("lets crawlers in, but not into private pages, and points at the sitemap", () => {
        const robots = portalRobots("https://portal.test");
        expect(robots).toContain("Disallow: /account");
        expect(robots).toContain("Allow: /api/auxiliary/media/");
        expect(robots).toContain("Sitemap: https://portal.test/sitemap.xml");
    });

    it("lists the apex's pages: home, blog, business page, landing pages, company sites and items", async () => {
        const xml = await portalSitemap({host: "portal.test", baseUrl: "https://portal.test", languageCode: "en-US", logger: getLogger("test")}, blog);
        for (const path of ["/", "/blog", "/blog/spring", "/business", "/fixture/in/tirane", "/fixture/adria", "/fixture/adria/item?id=1"]) {
            expect(xml).toContain(`<loc>https://portal.test${path}</loc>`);
        }
        expect(xml).not.toContain("/fixture/in/vlore");
    });
});
