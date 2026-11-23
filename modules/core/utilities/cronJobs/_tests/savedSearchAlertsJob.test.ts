import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";

vi.hoisted(() => {
    // Core alone (CORE-01): the catalog comes from a fixture section; links point at this portal.
    process.env.ENABLED_MODULES = "core";
    process.env.SINFONIA_CLIENT_URLS = "core=http://panel.localhost:5211,portal=http://portal.localhost:5212";
});

import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";
import mongoose from "mongoose";
import {ObjectId} from "mongodb";
import {asCrossTenant} from "@coreModule/utilities/endpoints/tenantScope";
import {clearPortalProviders, registerPortalProvider} from "@coreModule/domain/portal/portalProviderRegistry";
import type {PortalNewSinceContext} from "@coreModule/domain/portal/portalProvider.types";
import PortalSavedSearch from "@coreModule/database/schemas/portalSavedSearch/portalSavedSearch";
import {runSavedSearchAlerts, SAVED_SEARCH_STOP_PURPOSE} from "@coreModule/utilities/cronJobs/savedSearchAlertsJob";
import {buildSavedSearchAlertMail, type SavedSearchDigest} from "@coreModule/utilities/emails/savedSearchAlertMail";
import {validateRecordAccessToken} from "@coreModule/utilities/security/recordAccessToken";
import type {PortalCatalogItem} from "armonia/src/modules/core/api/portal/public/portal/portal.dto";
import {fixtureSectionNames} from "@coreModule/domain/portal/_tests/fixtureSectionNames";

/* D178, P23.7: the daily saved-search alert asks the portal's sections what is new and emails each person a digest. */

const platform = new ObjectId();
const adria = new ObjectId();
const other = new ObjectId();
const ada = new ObjectId();
const marco = new ObjectId();
const lastAlert = new Date("2026-11-01T08:00:00Z");
const now = new Date("2026-11-02T08:00:00Z");
const raw = <T>(fn: () => Promise<T>) => asCrossTenant("test fixtures span companies", fn);

/** The fixture catalog: gadgets by the company listing them and the day they were listed. */
const gadgets = [
    {id: "lamp-new", title: "Desk lamp", company: adria, listed: new Date("2026-11-01T20:00:00Z"), price: 40},
    {id: "lamp-newer", title: "Floor lamp", company: adria, listed: new Date("2026-11-02T06:00:00Z"), price: 90},
    {id: "lamp-old", title: "Old lamp", company: adria, listed: new Date("2026-10-01T00:00:00Z"), price: 10},
    {id: "chair-new", title: "Chair", company: adria, listed: new Date("2026-11-01T21:00:00Z"), price: 70},
];
const asked: PortalNewSinceContext[] = [];

function search(fields: Record<string, unknown>) {
    return {company: platform, filters: {}, languageCode: "en-US", alerts: true, lastAlertAt: lastAlert, deletedAt: null, ...fields};
}

beforeAll(async () => {
    await connectTestDatabase();
}, 120000);

afterAll(async () => {
    clearPortalProviders();
    await disconnectTestDatabase();
});

beforeEach(() => raw(async () => {
    for (const collection of await mongoose.connection.db!.collections()) await collection.deleteMany({});
    await mongoose.connection.db!.collection("companies").insertMany([
        {_id: platform, name: "Platform", vat: "CHE-1", isPlatformOwner: true, isActive: true, modules: ["core"], deletedAt: null},
        {_id: adria, name: "Adria", vat: "CHE-2", siteSlug: "adria", isActive: true, modules: ["core"], deletedAt: null},
    ]);
    await mongoose.connection.db!.collection("users").insertMany([
        {_id: ada, username: "ada@example.com", name: "Ada", surname: "Lovelace", preferredLanguage: "de-CH", isVisitor: false},
        {_id: marco, username: "marco@example.com", name: "Marco", surname: "Polo", isVisitor: false},
    ]);
    asked.length = 0;
    clearPortalProviders();
    registerPortalProvider({
        key: "fixture",
        order: 10,
        ...fixtureSectionNames(),
        kinds: ["gadget"],
        companyIds: async (scope) => scope.companyId ? [scope.companyId] : [adria],
        citiesByCompany: async () => new Map([[adria.toString(), ["Tirana"]]]),
        browse: async () => ({items: [], total: 0}),
        newSince: async (context) => {
            asked.push(context);
            const found = gadgets
                .filter((gadget) => gadget.listed > context.since && context.companyIds.some((id) => id.equals(gadget.company)))
                .filter((gadget) => !context.query || gadget.title.toLowerCase().includes(context.query.toLowerCase()))
                .sort((a, b) => b.listed.getTime() - a.listed.getTime());
            const items: PortalCatalogItem[] = found.slice(0, context.limit).map((gadget) => ({
                kind: "gadget", id: gadget.id, title: gadget.title, price: {amount: gadget.price, currency: "EUR"}, city: "Tirana",
                section: "fixture", path: `/gadgets/${gadget.id}`, company: {name: "Adria", slug: "adria"},
            }));
            return {items, total: found.length};
        },
    });
}));

describe("the daily saved-search alert (P23.7)", () => {
    it("sends each person one digest of what is new for their searches, then moves their searches on", async () => {
        const [apexLamps, siteAll, off, marcos] = [new ObjectId(), new ObjectId(), new ObjectId(), new ObjectId()];
        await raw(() => PortalSavedSearch.collection.insertMany([
            search({_id: apexLamps, user: ada, label: "Gadgets · lamp", kind: "gadget", query: "lamp", priceMax: 100, filters: {color: ["red", "blue"]}}),
            search({_id: siteAll, user: ada, label: "Everything at Adria", siteCompany: adria}),
            search({_id: off, user: ada, label: "Switched off", alerts: false}),
            search({_id: marcos, user: marco, label: "Marco's lamps", query: "lamp", lastAlertAt: now}),
            // Stored in another company: never the platform's to send.
            search({user: ada, label: "Elsewhere", company: other}),
        ]));
        const sent: SavedSearchDigest[] = [];

        const result = await raw(() => runSavedSearchAlerts(platform, {now, deliver: async (digest) => { sent.push(digest); }}));

        expect(result).toEqual({searches: 3, people: 2, sent: 1, failed: 0, items: 5});
        expect(sent).toHaveLength(1);
        const [digest] = sent;
        expect(digest).toEqual(expect.objectContaining({email: "ada@example.com", fullName: "Ada Lovelace", languageCode: "de-CH"}));
        expect(digest.blocks.map((block) => [block.label, block.total, block.items.map((item) => item.id)])).toEqual([
            ["Gadgets · lamp", 2, ["lamp-newer", "lamp-new"]],
            ["Everything at Adria", 3, ["lamp-newer", "chair-new", "lamp-new"]],
        ]);
        // Asked with the saved query, from the last alert on.
        expect(asked).toContainEqual(expect.objectContaining({kind: "gadget", query: "lamp", priceMax: 100, filters: {color: ["red", "blue"]}, since: lastAlert, scope: {}}));
        expect(asked).toContainEqual(expect.objectContaining({scope: {companyId: adria}, companyIds: [adria]}));

        const [apexBlock, siteBlock] = digest.blocks;
        expect(apexBlock.resultsUrl).toBe("http://portal.localhost:5212/?kind=gadget&q=lamp&priceMax=100&f.color=red&f.color=blue&sort=newest");
        expect(siteBlock.resultsUrl).toBe("http://adria.portal.localhost:5212/?sort=newest");
        const stop = new URL(apexBlock.stopUrl);
        expect(stop.origin + stop.pathname).toBe("http://portal.localhost:5212/saved-searches/stop");
        expect(validateRecordAccessToken(stop.searchParams.get("token") ?? "", SAVED_SEARCH_STOP_PURPOSE)).toEqual(expect.objectContaining({companyId: platform.toString(), recordId: apexLamps.toString()}));

        const after = await raw(() => PortalSavedSearch.find({company: platform}).lean().exec());
        const alertAt = (id: ObjectId) => after.find((row) => row._id.equals(id))?.lastAlertAt.getTime();
        expect([alertAt(apexLamps), alertAt(siteAll), alertAt(marcos)]).toEqual([now.getTime(), now.getTime(), now.getTime()]);
        expect(alertAt(off)).toBe(lastAlert.getTime());
    });

    it("keeps a person's searches for the next run when their email could not be sent", async () => {
        const lamps = new ObjectId();
        await raw(() => PortalSavedSearch.collection.insertOne(search({_id: lamps, user: ada, label: "Lamps", query: "lamp"})));

        const result = await raw(() => runSavedSearchAlerts(platform, {now, deliver: async () => { throw new Error("SMTP down"); }}));

        expect(result).toEqual(expect.objectContaining({sent: 0, failed: 1}));
        expect((await raw(() => PortalSavedSearch.findById(lamps).lean().exec()))?.lastAlertAt.getTime()).toBe(lastAlert.getTime());
    });

    it("leaves every search as it was in a process with no portal section registered (P23.12)", async () => {
        const lamps = new ObjectId();
        await raw(() => PortalSavedSearch.collection.insertOne(search({_id: lamps, user: ada, label: "Lamps", query: "lamp"})));
        clearPortalProviders();
        const deliver = vi.fn(async () => undefined);

        expect(await raw(() => runSavedSearchAlerts(platform, {now, deliver}))).toEqual({searches: 0, people: 0, sent: 0, failed: 0, items: 0});
        expect(deliver).not.toHaveBeenCalled();
        expect((await raw(() => PortalSavedSearch.findById(lamps).lean().exec()))?.lastAlertAt.getTime()).toBe(lastAlert.getTime());
    });

    it("finds nothing to send in a company that stores no saved searches", async () => {
        await raw(() => PortalSavedSearch.collection.insertOne(search({user: ada, label: "Lamps"})));
        const deliver = vi.fn(async () => undefined);
        expect(await raw(() => runSavedSearchAlerts(adria, {now, deliver}))).toEqual({searches: 0, people: 0, sent: 0, failed: 0, items: 0});
        expect(deliver).not.toHaveBeenCalled();
    });
});

describe("the alert email (P23.7)", () => {
    it("writes each search's block in the person's language, with prices as words, what is left and the stop link", () => {
        const item = (id: string, title: string, price?: PortalCatalogItem["price"]): PortalCatalogItem => ({
            kind: "gadget", id, title, ...(price ? {price} : {}), city: "Tirana", section: "fixture", path: `/${id}`, company: {name: "Adria", slug: "adria"},
        });
        const {subject, html} = buildSavedSearchAlertMail({
            email: "ada@example.com",
            fullName: "Ada <Lovelace>",
            languageCode: "de-CH",
            blocks: [{
                label: "Autos · Tirana",
                items: [item("a", "Kompakt", {amount: 45, currency: "EUR", per: "day"}), item("b", "Kombi <XL>")],
                total: 3,
                resultsUrl: "http://portal.localhost:5212/?kind=car&sort=newest",
                stopUrl: "http://portal.localhost:5212/saved-searches/stop?token=abc",
            }],
        });

        expect(subject).toContain("3 neue Treffer");
        expect(html).toContain("Guten Tag Ada &lt;Lovelace&gt;,");
        expect(html).toContain("Autos · Tirana");
        expect(html).toContain("Kompakt · Adria, Tirana");
        expect(html).toMatch(/45.*\/ Tag/);
        expect(html).toContain("Kombi &lt;XL&gt;");
        expect(html).toContain("und 1 weiterer");
        expect(html).toContain("Alle 3 neuen Treffer ansehen");
        expect(html).toContain('href="http://portal.localhost:5212/saved-searches/stop?token=abc"');
        expect(html).not.toMatch(/\{[a-zA-Z]+\}/);
    });
});
