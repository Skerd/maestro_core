import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";

vi.mock("@coreModule/environment", async (importOriginal) => ({...await importOriginal<object>(), PORTAL_ROOT_DOMAIN: "kudoo.test"}));

import mongoose from "mongoose";
import {ObjectId} from "mongodb";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";
import {getLogger} from "@coreModule/loggers/serverLog";
import {inBlogScope, listPublicBlog} from "@coreModule/api/auxiliary/public/blog";

const companies = {
    platform: new ObjectId(),
    approved: new ObjectId(),
    pending: new ObjectId(),
    hidden: new ObjectId(),
    inactive: new ObjectId(),
};

async function seed(): Promise<void> {
    const db = mongoose.connection;
    const company = (_id: ObjectId, name: string, extra: Record<string, unknown> = {}) =>
        ({_id, company: _id, name, isActive: true, hiddenFromPortal: false, deletedAt: null, ...extra});
    await db.collection("companies").insertMany([
        company(companies.platform, "Platform", {isPlatformOwner: true}),
        company(companies.approved, "Approved shop", {portalApproval: {status: "approved"}}),
        company(companies.pending, "Waiting shop", {portalApproval: {status: "pending"}}),
        company(companies.hidden, "Hidden shop", {hiddenFromPortal: true}),
        company(companies.inactive, "Closed shop", {isActive: false}),
    ]);
    const categories = Object.entries(companies).map(([key, id]) => ({_id: new ObjectId(), company: id, name: `News ${key}`, slug: "news", deletedAt: null}));
    await db.collection("blogcategories").insertMany(categories);
    await db.collection("blogposts").insertMany(categories.map((category) => ({
        company: category.company,
        category: category._id,
        title: `Post of ${category.name}`,
        slug: `post-${category.company.toString()}`,
        content: "Text",
        published: true,
        publishedAt: new Date(),
        createdAt: new Date(),
        deletedAt: null,
    })));
}

function apexTitles(): Promise<string[]> {
    const params = {origin: "kudoo.test", languageCode: "en-US", logger: getLogger("portal_apex_blog_test"), page: 1, limit: 50};
    return inBlogScope(params.origin, () => listPublicBlog(params)).then((result) => result.posts.map((post) => post.title).sort());
}

beforeAll(async () => {
    await connectTestDatabase();
}, 120000);

afterAll(async () => {
    await disconnectTestDatabase();
});

beforeEach(async () => {
    for (const name of ["companies", "blogcategories", "blogposts"]) await mongoose.connection.collection(name).deleteMany({});
    await seed();
});

describe("the portal's own blog (the apex)", () => {
    it("lists posts only of companies the portal may list: not hidden, not inactive, not waiting for approval", async () => {
        expect(await apexTitles()).toEqual(["Post of News approved", "Post of News platform"]);
    });

    it("drops a company's posts once the platform hides it", async () => {
        await mongoose.connection.collection("companies").updateOne({_id: companies.approved}, {$set: {hiddenFromPortal: true}});

        expect(await apexTitles()).toEqual(["Post of News platform"]);
    });
});
