import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";

vi.hoisted(() => {
    // Core alone (CORE-01): the catalog comes from a fixture section.
    process.env.ENABLED_MODULES = "core";
});
vi.mock("@coreModule/utilities/middlewares/authMW", async () => {
    const {authMWStub} = await import("@coreModule/_tests/httpHarness");
    return authMWStub;
});
vi.mock("@coreModule/utilities/middlewares/rateLimiter", () => ({
    rateLimiter: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";
import mongoose from "mongoose";
import {ObjectId} from "mongodb";
import request from "supertest";
import {appFor, callerHeader, type TestCaller} from "@coreModule/_tests/httpHarness";
import {asCrossTenant} from "@coreModule/utilities/endpoints/tenantScope";
import {PORTAL_ROOT_DOMAIN} from "@coreModule/environment";
import {clearPortalProviders, registerPortalProvider} from "@coreModule/domain/portal/portalProviderRegistry";
import type {PortalNewSinceContext} from "@coreModule/domain/portal/portalProvider.types";
import {generateRecordAccessToken} from "@coreModule/utilities/security/recordAccessToken";
import {SAVED_SEARCH_STOP_PURPOSE} from "@coreModule/utilities/cronJobs/savedSearchAlertsJob";
import PortalFavourite from "@coreModule/database/schemas/portalFavourite/portalFavourite";
import PortalSavedSearch from "@coreModule/database/schemas/portalSavedSearch/portalSavedSearch";
import * as savedRoute from "@coreModule/api/portal/private/saved";
import * as stopRoute from "@coreModule/api/portal/public/savedSearchAlerts";
import type {PortalCatalogItem} from "armonia/src/modules/core/api/portal/public/portal/portal.dto";
import {fixtureSectionNames} from "@coreModule/domain/portal/_tests/fixtureSectionNames";

/* D178, P23.7: what a portal account keeps, one list per person across hosts, stored in the platform company. */

const platform = new ObjectId();
const shop = new ObjectId();
const app = appFor([{...savedRoute, module: "core"}, {...stopRoute, module: "core"}]);
// Ada signs in on a shop's own site: her session company is the shop, her lists are the platform's.
const ada: TestCaller = {userId: new ObjectId().toString(), companyId: shop.toString(), modules: ["core"]};
const marco: TestCaller = {userId: new ObjectId().toString(), companyId: platform.toString(), modules: ["core"]};
const raw = <T>(fn: () => Promise<T>) => asCrossTenant("test reads the saved lists", fn);
const SHOP_SITE = `http://adria.${PORTAL_ROOT_DOMAIN}`;

/** The fixture catalog: gadgets, each listed by the shop, at a price that can change. */
const catalog = new Map<string, {price: number}>();
const asked: PortalNewSinceContext[] = [];
function gadget(id: string): PortalCatalogItem {
    return {kind: "gadget", id, title: `Gadget ${id}`, price: {amount: catalog.get(id)?.price ?? 0, currency: "EUR"}, section: "fixture", path: `/gadgets/${id}`, company: {name: "Shop", slug: "shop"}};
}

const as = (caller: TestCaller) => ({
    keep: (id: string) => request(app).put("/api/portal/saved/favourites").set(callerHeader(caller)).send({kind: "gadget", id, section: "fixture", path: `/gadgets/${id}`}),
    drop: (id: string) => request(app).delete("/api/portal/saved/favourites").set(callerHeader(caller)).send({kind: "gadget", id}),
    keys: () => request(app).post("/api/portal/saved/favourites/keys").set(callerHeader(caller)).send({}),
    saved: (origin?: string) => request(app).post("/api/portal/saved").set(callerHeader(caller)).set("Origin", origin ?? "").send({}),
    save: (form: Record<string, unknown>, origin?: string) => request(app).put("/api/portal/saved/searches").set(callerHeader(caller)).set("Origin", origin ?? "").send(form),
    alerts: (_id: string, alerts: boolean) => request(app).post("/api/portal/saved/searches/alerts").set(callerHeader(caller)).send({_id, alerts}),
    remove: (_id: string) => request(app).delete("/api/portal/saved/searches").set(callerHeader(caller)).send({_id}),
});

beforeAll(async () => {
    await connectTestDatabase();
    await Promise.all([PortalFavourite.init(), PortalSavedSearch.init()]);
}, 120000);

afterAll(async () => {
    clearPortalProviders();
    await disconnectTestDatabase();
});

beforeEach(() => raw(async () => {
    for (const collection of await mongoose.connection.db!.collections()) await collection.deleteMany({});
    await mongoose.connection.db!.collection("companies").insertMany([
        {_id: platform, name: "Platform", vat: "CHE-1", isPlatformOwner: true, isActive: true, modules: ["core"], deletedAt: null},
        {_id: shop, name: "Shop", vat: "CHE-2", siteSlug: "adria", isPlatformOwner: false, isActive: true, modules: ["core"], deletedAt: null},
    ]);
    catalog.clear();
    catalog.set("g1", {price: 40}).set("g2", {price: 15});
    asked.length = 0;
    clearPortalProviders();
    registerPortalProvider({
        key: "fixture",
        order: 10,
        ...fixtureSectionNames(),
        kinds: ["gadget"],
        companyIds: async () => [shop],
        citiesByCompany: async () => new Map(),
        browse: async () => ({items: [], total: 0}),
        newSince: async (context) => {
            asked.push(context);
            const ids = [...catalog.keys()].filter((id) => !context.ids || context.ids.includes(id));
            return {items: ids.map(gadget), total: ids.length};
        },
    });
}));

describe("a person's kept items (P23.7)", () => {
    it("keeps an item in the platform company as the person's, and shows it as the catalog lists it now", async () => {
        const kept = await as(ada).keep("g1");
        expect(kept.body.error_code ?? "ok").toBe("ok");
        expect(kept.body.data).toEqual(["gadget:g1"]);
        const stored = await raw(() => PortalFavourite.findOne({}).lean().exec());
        expect(stored?.company).toEqual(platform);
        expect(String(stored?.user)).toBe(ada.userId);

        catalog.set("g1", {price: 35});
        const saved = await as(ada).saved();
        expect(saved.body.data.favourites).toEqual([expect.objectContaining({id: "g1", price: {amount: 35, currency: "EUR"}})]);
        expect(saved.body.data.unavailable).toBe(0);
        expect(asked.at(-1)).toEqual(expect.objectContaining({kind: "gadget", ids: ["g1"], since: new Date(0)}));
    });

    it("keeps an item once, drops only the person's own, and counts kept items the host no longer lists", async () => {
        await as(ada).keep("g1");
        await as(ada).keep("g1");
        await as(ada).keep("g2");
        await as(marco).keep("g1");
        expect(await raw(() => PortalFavourite.countDocuments({user: new ObjectId(ada.userId), deletedAt: null}).exec())).toBe(2);

        expect((await as(ada).drop("g1")).body.data).toEqual(["gadget:g2"]);
        expect((await as(marco).keys()).body.data).toEqual(["gadget:g1"]);

        catalog.delete("g2");
        const saved = await as(ada).saved();
        expect(saved.body.data.favourites).toEqual([]);
        expect(saved.body.data.unavailable).toBe(1);
    });

    it("refuses a kind no portal section lists", async () => {
        const refused = await request(app).put("/api/portal/saved/favourites").set(callerHeader(ada)).send({kind: "spaceship", id: "x", section: "fixture", path: "/x"});
        expect(refused.body.error_code).toBe("not_found");
        expect(await raw(() => PortalFavourite.countDocuments({}).exec())).toBe(0);
    });
});

describe("a person's saved searches (P23.7)", () => {
    it("saves the browse query with the host it was saved on, and lists only the person's own", async () => {
        const before = Date.now();
        const saved = await as(ada).save({label: "Gadgets · lamp", kind: "gadget", query: " lamp ", priceMax: 50, filters: {color: ["red", "blue"]}}, SHOP_SITE);
        expect(saved.body.error_code ?? "ok").toBe("ok");
        expect(saved.body.data).toEqual(expect.objectContaining({label: "Gadgets · lamp", kind: "gadget", query: "lamp", priceMax: 50, filters: {color: ["red", "blue"]}, alerts: true}));
        const stored = await raw(() => PortalSavedSearch.findOne({}).lean().exec());
        expect(stored).toEqual(expect.objectContaining({company: platform, siteCompany: shop, languageCode: "en-US", alerts: true}));
        expect(stored!.lastAlertAt.getTime()).toBeGreaterThanOrEqual(before);

        await as(marco).save({label: "Everything"});
        const own = await as(ada).saved();
        expect(own.body.data.searches.map((search: {label: string}) => search.label)).toEqual(["Gadgets · lamp"]);
        expect((await raw(() => PortalSavedSearch.findOne({label: "Everything"}).lean().exec()))?.siteCompany).toBeUndefined();
    });

    it("turns alerts off and on, and deletes, only the person's own search", async () => {
        const {body} = await as(ada).save({label: "Gadgets"});
        const id = body.data._id;
        await raw(() => PortalSavedSearch.updateOne({_id: new ObjectId(id)}, {$set: {lastAlertAt: new Date("2026-01-01")}}).exec());

        expect((await as(marco).alerts(id, false)).body.error_code).toBe("not_found");
        expect((await as(marco).remove(id)).body.error_code).toBe("not_found");

        expect((await as(ada).alerts(id, false)).body.data.alerts).toBe(false);
        expect((await as(ada).alerts(id, true)).body.data.alerts).toBe(true);
        // Turned back on, the next alert starts from now, not from the day it was turned off.
        expect((await raw(() => PortalSavedSearch.findById(id).lean().exec()))!.lastAlertAt.getTime()).toBeGreaterThan(new Date("2026-02-01").getTime());

        expect((await as(ada).remove(id)).body.data).toEqual({_id: id});
        expect((await as(ada).saved()).body.data.searches).toEqual([]);
    });

    it("refuses a search past the limit", async () => {
        await raw(() => PortalSavedSearch.collection.insertMany(Array.from({length: 20}, (_, index) => ({
            user: new ObjectId(ada.userId), company: platform, label: `Search ${index}`, filters: {}, languageCode: "en-US", alerts: true, lastAlertAt: new Date(), deletedAt: null,
        }))));
        expect((await as(ada).save({label: "One more"})).body.error_code).toBe("portal_saved_searches_limit_reached");
        expect((await as(marco).save({label: "Marco's first"})).body.error_code ?? "ok").toBe("ok");
    });

    it("stops one search's alerts from the email's link, without signing in, and nothing else", async () => {
        const {body} = await as(ada).save({label: "Gadgets"});
        const stop = (token: string) => request(app).post("/api/portal/savedSearchAlerts/stop").set(callerHeader(marco)).send({token});
        const token = generateRecordAccessToken({purpose: SAVED_SEARCH_STOP_PURPOSE, companyId: platform, recordId: body.data._id, version: 0});

        const stopped = await stop(token);
        expect(stopped.body.data).toEqual({label: "Gadgets"});
        expect((await raw(() => PortalSavedSearch.findById(body.data._id).lean().exec()))?.alerts).toBe(false);

        const otherPurpose = generateRecordAccessToken({purpose: "appointment", companyId: platform, recordId: body.data._id, version: 0});
        // `not_found`, never `token_verification_failed`: the portal would read that as an expired session.
        expect((await stop(otherPurpose)).body.error_code).toBe("not_found");
        expect((await stop("not-a-token")).body.error_code).toBe("not_found");
    });
});
