import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import {ObjectId} from "mongodb";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";

// No network and no GridFS: a failed download falls back to the placeholder image, and the upload only returns an id.
vi.mock("@coreModule/utilities/gridfs/gridfsStorage", () => ({
    createGridFSStorage: () => ({uploadFile: async () => new ObjectId().toString()}),
}));

import Media from "@coreModule/database/schemas/media/media";
import {getLogger} from "@coreModule/loggers/serverLog";
import {asCrossTenant} from "@coreModule/utilities/endpoints/tenantScope";
import type {ICompany} from "@coreModule/database/schemas/company/company";
import {resolveDemoImagesFromUnsplash} from "@coreModule/database/demo/demoMedia";

const companyA = {_id: new ObjectId(), name: "A"} as unknown as ICompany;
const companyB = {_id: new ObjectId(), name: "B"} as unknown as ICompany;
const createdBy = new ObjectId();
const logger = getLogger("demo_media_test");
const photo = `test-${new ObjectId().toString()}`;
const resolve = (company: ICompany) => asCrossTenant("test seeds two companies", () =>
    resolveDemoImagesFromUnsplash([photo], "listing-01", "Logo design", company, createdBy, logger, "listing", {width: 16, height: 16}));

beforeAll(async () => {
    await connectTestDatabase();
    vi.stubGlobal("fetch", vi.fn(async () => {
        throw new Error("offline");
    }));
}, 120000);

afterAll(async () => {
    vi.unstubAllGlobals();
    await disconnectTestDatabase();
});

beforeEach(async () => {
    await asCrossTenant("test setup", () => Media.collection.deleteMany({}));
});

describe("demo seed images per company (D104)", () => {
    it("reuses a company's own image on a re-seed, and gives a second company its own image of the same kit", async () => {
        const first = await resolve(companyA);
        const again = await resolve(companyA);
        const other = await resolve(companyB);

        expect(again.galleryIds.map(String)).toEqual(first.galleryIds.map(String));
        expect(other.galleryIds).toHaveLength(1);
        expect(String(other.mainImageId)).not.toBe(String(first.mainImageId));
        const owners = await asCrossTenant("test reads both", () => Media.find({}).select("company").lean<{company: ObjectId}[]>());
        expect(owners.map((media) => String(media.company)).sort()).toEqual([String(companyA._id), String(companyB._id)].sort());
    });
});
