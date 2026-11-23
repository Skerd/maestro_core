import {afterAll, beforeAll, beforeEach, describe, expect, it} from "vitest";
import {ObjectId} from "mongodb";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";
import Company from "@coreModule/database/schemas/company/company";
import {markVerifiedCompanies} from "@coreModule/domain/portal/portalVerified";

/* D178: catalog items of companies the platform verified carry the mark, found by their portal slug. */

const verifiedId = new ObjectId();
const slugless = new ObjectId();
const plainId = new ObjectId();

beforeAll(async () => {
    await connectTestDatabase();
}, 120000);

afterAll(async () => {
    await disconnectTestDatabase();
});

beforeEach(async () => {
    await Company.collection.deleteMany({});
    await Company.collection.insertMany([
        {_id: verifiedId, company: verifiedId, name: "Checked", siteSlug: "checked", verifiedAt: new Date(), isActive: true, deletedAt: null},
        {_id: slugless, company: slugless, name: "No slug", verifiedAt: new Date(), isActive: true, deletedAt: null},
        {_id: plainId, company: plainId, name: "Plain", siteSlug: "plain", isActive: true, deletedAt: null},
    ]);
});

const item = (slug: string) => ({kind: "product", id: slug, title: slug, section: "shop", path: "/", company: {name: slug, slug}} as {company: {name: string; slug: string; verified?: boolean}} & Record<string, unknown>);

describe("markVerifiedCompanies", {timeout: 60000}, () => {
    it("marks items by site slug or by id, and leaves the others alone", async () => {
        const items = [item("checked"), item(slugless.toString()), item("plain")];
        await markVerifiedCompanies(items as never);
        expect(items.map((entry) => entry.company.verified === true)).toEqual([true, true, false]);
    });

    it("does nothing for no items", async () => {
        await expect(markVerifiedCompanies([])).resolves.toBeUndefined();
    });
});
