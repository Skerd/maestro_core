import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";

const ids = vi.hoisted(() => ({platform: "64b000000000000000000001", shop: "64b000000000000000000002"}));

// The harness stub, with the platform company marked as the platform owner, as authMW loads it.
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

import mongoose from "mongoose";
import {ObjectId} from "mongodb";
import request from "supertest";
import {allPermissionTags, appFor, callerHeader, type TestCaller} from "@coreModule/_tests/httpHarness";
import {asCrossTenant} from "@coreModule/utilities/endpoints/tenantScope";
import * as cityRoute from "@coreModule/api/auxiliary/private/city";
import * as blogPostRoute from "@coreModule/api/auxiliary/private/blogPost";
import Company from "@coreModule/database/schemas/company/company";
import Country from "@coreModule/database/schemas/country/country";
import City from "@coreModule/database/schemas/city/city";
import BlogCategory from "@coreModule/database/schemas/blogCategory/blogCategory";
import BlogPost from "@coreModule/database/schemas/blogPost/blogPost";
import User from "@coreModule/database/schemas/user/user";
import type {FilterGroup, FilterRule} from "armonia/src/modules/core/database/filter";

const platform = new ObjectId(ids.platform);
const shop = new ObjectId(ids.shop);
const app = appFor([
    {...cityRoute, module: "core"},
    {...blogPostRoute, module: "core"},
]);
const permissions = allPermissionTags([City, Country, BlogPost, BlogCategory, User]);
const author = new ObjectId();
const caller = (company: ObjectId, tags = permissions): TestCaller =>
    ({userId: new ObjectId().toString(), companyId: company.toString(), isAdmin: true, permissions: tags});

let n = 0;
const rule = (field: string, value: string): FilterRule => ({id: `r${++n}`, field, operator: "contains", value});
const group = (operator: "and" | "or", rules: FilterRule[], groups: FilterGroup[] = []): FilterGroup =>
    ({id: `g${++n}`, operator, rules, groups});

async function listNames(path: string, who: TestCaller, filter: FilterGroup, nameField = "name"): Promise<string[]> {
    const res = await request(app).post(path).set(callerHeader(who)).send({offset: 0, limit: 50, filter});
    expect(res.body.error_code ?? "ok").toBe("ok");
    return (res.body.data as Record<string, string>[]).map((row) => row[nameField]).sort();
}
const cities = (filter: FilterGroup) => listNames("/api/auxiliary/city", caller(platform), filter);

beforeAll(async () => {
    await connectTestDatabase();
}, 120000);

afterAll(async () => {
    await disconnectTestDatabase();
});

beforeEach(() => asCrossTenant("test fixtures span companies", async () => {
    for (const collection of await mongoose.connection.db!.collections()) {
        await collection.deleteMany({});
    }
    await Company.collection.insertMany([
        {_id: platform, company: platform, name: "Kudoo", vat: "P-1", isPlatformOwner: true, isActive: true, modules: ["core"], deletedAt: null},
        {_id: shop, company: platform, name: "Shop", vat: "S-1", isActive: true, modules: ["core"], deletedAt: null},
    ]);
    const albania = new ObjectId();
    const italy = new ObjectId();
    const live = {company: platform, requestStatus: "approved", deletedAt: null};
    await Country.collection.insertMany([
        {_id: albania, name: "Albania", code: "AL", phoneCode: "+355", ...live},
        {_id: italy, name: "Italy", code: "IT", phoneCode: "+39", ...live},
    ]);
    await User.collection.insertOne({_id: author, username: "ermal@example.com", name: "Ermal", surname: "Kola", companies: [platform], deletedAt: null});
    await City.collection.insertMany([
        {name: "Tirana", country: albania, createdBy: author, ...live},
        {name: "Durrës", country: albania, ...live},
        {name: "Rome", country: italy, ...live},
    ]);
    const travel = new ObjectId();
    const news = new ObjectId();
    await BlogCategory.collection.insertMany([
        {_id: travel, company: shop, name: "Travel tips", slug: "travel-tips", deletedAt: null},
        {_id: news, company: shop, name: "News", slug: "news", deletedAt: null},
    ]);
    await BlogPost.collection.insertMany([
        {company: shop, title: "Packing light", slug: "packing-light", content: "…", category: travel, deletedAt: null},
        {company: shop, title: "We moved", slug: "we-moved", content: "…", category: news, deletedAt: null},
    ]);
}));

describe("contains on a reference: search by the linked record's name (D170)", {timeout: 30000}, () => {
    it("matches rows by their linked record's name, any case", async () => {
        expect(await cities(group("and", [rule("country", "ALBAN")]))).toEqual(["Durrës", "Tirana"]);
        expect(await cities(group("and", [rule("country", "ital")]))).toEqual(["Rome"]);
    });

    it("matches every word in one of the name fields", async () => {
        expect(await cities(group("and", [rule("country", "al albania")]))).toEqual(["Durrës", "Tirana"]);
        expect(await cities(group("and", [rule("country", "albania italy")]))).toEqual([]);
    });

    it("matches no row, never every row, when no linked record has the name", async () => {
        expect(await cities(group("and", [rule("country", "atlantis")]))).toEqual([]);
        // Inside an OR the other rules still decide: the list search is one such group per word.
        expect(await cities(group("and", [], [group("or", [rule("name", "rom"), rule("country", "rom")])]))).toEqual(["Rome"]);
        expect(await cities(group("and", [], [group("or", [rule("name", "ital"), rule("country", "ital")])]))).toEqual(["Rome"]);
    });

    // Users are no tenant's rows: the lookup looks only among the users the list's own rows name.
    it("matches a linked user by name and surname", async () => {
        expect(await cities(group("and", [rule("createdBy", "ermal kola")]))).toEqual(["Tirana"]);
        expect(await cities(group("and", [rule("createdBy", "kola ermal")]))).toEqual(["Tirana"]);
    });

    it("matches a company's own linked records under the tenant scope", async () => {
        const posts = (who: TestCaller, text: string) => listNames("/api/auxiliary/blogPost", who, group("and", [rule("category", text)]), "title");
        expect(await posts(caller(shop), "travel")).toEqual(["Packing light"]);
        // Another company's categories never match: its lookup only sees its own.
        expect(await posts(caller(platform), "travel")).toEqual([]);
    });

    it("matches only names the caller may read on the linked record", async () => {
        const withoutCategoryName = permissions.filter((tag) => !(tag.startsWith("blogcategories[") && tag.includes("name")));
        expect(withoutCategoryName.length).toBeLessThan(permissions.length);
        const res = await request(app).post("/api/auxiliary/blogPost").set(callerHeader(caller(shop, withoutCategoryName)))
            .send({offset: 0, limit: 50, filter: group("and", [rule("category", "travel")])});
        expect(res.body.error_code ?? "ok").toBe("ok");
        expect(res.body.total).toBe(0);
    });
});
