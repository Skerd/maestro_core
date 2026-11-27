import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";

const ids = vi.hoisted(() => ({platform: "64a000000000000000000011", shop: "64a000000000000000000012"}));

// The harness stub, with the caller's company marked as the platform owner when it is the platform, as authMW loads it.
vi.mock("@coreModule/utilities/middlewares/authMW", async () => {
    const {authMWStub} = await import("@coreModule/_tests/httpHarness");
    return {
        default: (scope?: string) => (req: {body: Record<string, any>}, res: unknown, next: () => void) =>
            authMWStub.default(scope)(req, res, () => {
                req.body.company = {...req.body.company, isPlatformOwner: String(req.body.company._id) === ids.platform};
                next();
            }),
    };
});
vi.mock("@coreModule/utilities/middlewares/rateLimiter", () => ({
    rateLimiter: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import mongoose, {Schema, SchemaTypes, type Types} from "mongoose";
import {Router} from "express";
import {ObjectId} from "mongodb";
import request from "supertest";
import {allPermissionTags, appFor, callerHeader, type TestCaller} from "@coreModule/_tests/httpHarness";
import {asCrossTenant} from "@coreModule/utilities/endpoints/tenantScope";
import {addPlatformListTreeRoute} from "@coreModule/api/platformListRoute";
import ownershipPlugin from "@coreModule/database/plugins/ownershipPlugin";
import requestablePlugin from "@coreModule/database/plugins/requestablePlugin";
import {normalizeSchemaPermissions} from "@coreModule/database/utilities";
import {BaseCrudService} from "@coreModule/database/services/baseCrudService";
import Company from "@coreModule/database/schemas/company/company";
import type {RequestableEntry} from "@coreModule/api/requestableActions";

type IFixture = RequestableEntry & {name: string; names?: Record<string, string>; slug?: string; parentNode?: Types.ObjectId; order: number; searchText?: string};

// A core fixture: a tree-shaped platform list with names in every language, like the product and service categories.
const FixtureSchema = new Schema<IFixture>({
    name: {type: SchemaTypes.String, required: true},
    names: {type: new Schema({en: String, sq: String, de: String, fr: String, it: String}, {_id: false})},
    slug: {type: SchemaTypes.String},
    parentNode: {type: SchemaTypes.ObjectId, ref: "PlatformTreeFixture"},
    order: {type: SchemaTypes.Number, default: 0},
    searchText: {type: SchemaTypes.String},
}, {accessMode: "loose", collection: "platformtreefixtures"});
ownershipPlugin(FixtureSchema, {tenantScoped: false});
requestablePlugin(FixtureSchema);
const Fixture = mongoose.model<IFixture>("PlatformTreeFixture", FixtureSchema);
normalizeSchemaPermissions(Fixture);
const fixtureService = new BaseCrudService<IFixture, typeof Fixture>(Fixture, "PlatformTreeFixture");

const platform = new ObjectId(ids.platform);
const shop = new ObjectId(ids.shop);
const router = Router();
addPlatformListTreeRoute(router, {model: Fixture, service: fixtureService, parentField: "parentNode"});
const app = appFor([{basePath: "/api/test/tree", router}]);
const asShop: TestCaller = {userId: new ObjectId().toString(), companyId: shop.toString(), isAdmin: true, permissions: allPermissionTags([Fixture])};
const tree = (body: object, headers: Record<string, string> = {}) =>
    request(app).post("/api/test/tree/tree").set({...callerHeader(asShop), ...headers}).send(body);

const home = new ObjectId();
const plumbing = new ObjectId();
const leaks = new ObjectId();
const design = new ObjectId();
const row = (_id: ObjectId, en: string, sq: string, parentNode?: ObjectId, extra: object = {}) => ({
    _id, company: platform, name: en, names: {en, sq}, slug: en.toLowerCase(), order: 0, deletedAt: null,
    searchText: `${en} | ${sq}`.toLowerCase(), ...(parentNode ? {parentNode} : {}), ...extra,
});

beforeAll(async () => {
    await connectTestDatabase();
}, 120000);

afterAll(async () => {
    await disconnectTestDatabase();
});

beforeEach(() => asCrossTenant("test fixtures span companies", async () => {
    for (const collection of await mongoose.connection.db!.collections()) await collection.deleteMany({});
    await Company.collection.insertMany([
        {_id: platform, company: platform, name: "Kudoo", vat: "P-1", isPlatformOwner: true, isActive: true, modules: ["core"], deletedAt: null},
        {_id: shop, company: platform, name: "Shop", vat: "S-1", isActive: true, modules: ["core"], deletedAt: null},
    ]);
    await Fixture.collection.insertMany([
        row(home, "Home", "Shtëpi"),
        row(plumbing, "Plumbing", "Hidraulikë", home),
        row(leaks, "Leaks", "Rrjedhje", plumbing),
        row(design, "Design", "Dizajn"),
        // Another company's request: only that company and the platform see it.
        row(new ObjectId(), "Kites", "Balona", home, {requestStatus: "requested", requestedByCompany: new ObjectId()}),
    ]);
}));

describe("a platform list's tree route (addPlatformListTreeRoute, D195/D196)", () => {
    it("lists one level at a time with each entry's child count", async () => {
        const top = await tree({});
        expect(top.body.error_code ?? "ok").toBe("ok");
        expect(top.body.data.map((node: {name: string; childCount: number}) => [node.name, node.childCount]).sort())
            .toEqual([["Design", 0], ["Home", 1]]);
        const under = await tree({parent: String(home)});
        expect(under.body.data.map((node: {name: string}) => node.name)).toEqual(["Plumbing"]);
    });

    it("searches every language and names matches with their path in the reader's language", async () => {
        const found = await tree({search: "rrjedh"}, {"accept-language": "sq-AL", "x-language": "sq-AL"});
        expect(found.body.data).toHaveLength(1);
        expect(found.body.data[0]).toMatchObject({_id: String(leaks), childCount: 0});
        expect(found.body.data[0].path).toHaveLength(2);
    });
});
