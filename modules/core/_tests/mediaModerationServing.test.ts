import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";

vi.mock("@coreModule/utilities/middlewares/authMW", async () =>
    (await import("@coreModule/_tests/httpHarness")).authMWStub);
vi.mock("@coreModule/utilities/middlewares/rateLimiter", () => ({
    rateLimiter: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import {ObjectId} from "mongodb";
import {Readable} from "stream";
import request from "supertest";
import sharp from "sharp";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";
import {appFor, callerHeader, type TestCaller} from "@coreModule/_tests/httpHarness";
import Media from "@coreModule/database/schemas/media/media";
import {getGridFSStorage} from "@coreModule/utilities/gridfs/gridfsStorage";
import * as publicMediaRoute from "@coreModule/api/auxiliary/public/media";
import * as privateMediaRoute from "@coreModule/api/auxiliary/private/media";
import {testVideo} from "@coreModule/_tests/testVideo";

const app = appFor([
    {...publicMediaRoute, basePath: "/api/auxiliary/public/media"},
    {...privateMediaRoute, basePath: "/api/auxiliary/media"},
]);
const staff: TestCaller = {userId: new ObjectId().toString(), companyId: new ObjectId().toString()};
const visitor: TestCaller = {userId: new ObjectId().toString(), companyId: new ObjectId().toString()};
// The portal zone of the test environment (PORTAL_ROOT_DOMAIN), where any company's public media is served.
const PORTAL = "http://portal.localhost";

const binary = (res: any, callback: (error: Error | null, body: Buffer) => void) => {
    const chunks: Buffer[] = [];
    res.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    res.on("end", () => callback(null, Buffer.concat(chunks)));
};

/** A 200×120 public PNG of the staff's company, with the content check's verdict. */
async function storedImage(moderation?: string): Promise<string> {
    const png = await sharp({create: {width: 200, height: 120, channels: 3, background: "#336699"}}).png().toBuffer();
    const fileId = await getGridFSStorage("en-US", "media").uploadFile(Readable.from(png), "logo.png", {mimeType: "image/png"});
    const {insertedId} = await Media.collection.insertOne({
        type: "image", originalName: "logo.png", fileName: "logo.png", fileId: new ObjectId(fileId.toString()),
        mimeType: "image/png", extension: ".png", isPublic: true, company: new ObjectId(staff.companyId),
        metadata: {size: png.length, extension: ".png", mime: "image/png", safeCheckedFlag: false, ...(moderation && {moderation: {status: moderation}})},
    });
    return insertedId.toString();
}

/** A one-second public MP4 of the staff's company, with the content check's verdict. */
async function storedVideo(moderation: string): Promise<string> {
    const mp4 = testVideo(1);
    const fileId = await getGridFSStorage("en-US", "media").uploadFile(Readable.from(mp4), "clip.mp4", {mimeType: "video/mp4"});
    const {insertedId} = await Media.collection.insertOne({
        type: "video", originalName: "clip.mp4", fileName: "clip.mp4", fileId: new ObjectId(fileId.toString()),
        mimeType: "video/mp4", extension: ".mp4", isPublic: true, company: new ObjectId(staff.companyId),
        metadata: {size: mp4.length, extension: ".mp4", mime: "video/mp4", safeCheckedFlag: false, moderation: {status: moderation}},
    });
    return insertedId.toString();
}

const asVisitor = (mediaId: string) =>
    request(app).get(`/api/auxiliary/public/media/${mediaId}`).set(callerHeader(visitor)).set("Origin", PORTAL);
const asStaff = (path: string) =>
    request(app).get(`/api/auxiliary/media/${path}`).set(callerHeader(staff)).buffer(true).parse(binary);

beforeAll(async () => {
    await connectTestDatabase();
}, 120000);

afterAll(async () => {
    await disconnectTestDatabase();
});

beforeEach(async () => {
    await Media.collection.deleteMany({});
});

describe("visitors and the content check (D177)", () => {
    it("are served a public image that passed, was approved or predates the check", async () => {
        for (const status of ["passed", "approved", undefined]) {
            const res = await asVisitor(await storedImage(status));
            expect(res.status).toBe(200);
            expect(res.headers["content-type"]).toContain("image/png");
        }
    });

    it("are not sent an image flagged for review", async () => {
        const res = await asVisitor(await storedImage("flagged"));
        expect(res.body.error_code).toBe("media_not_found");
    });

    it("are not sent an image the review removed", async () => {
        const res = await asVisitor(await storedImage("rejected"));
        expect(res.body.error_code).toBe("media_not_found");
    });

    it("are not sent a video flagged for review", async () => {
        const res = await asVisitor(await storedVideo("flagged"));
        expect(res.body.error_code).toBe("media_not_found");
    });
});

describe("staff and the content check (D177)", () => {
    it("get a flagged image as a small blurred copy, and the image itself with ?reveal=1", async () => {
        const id = await storedImage("flagged");

        const blurred = await asStaff(id);
        expect(blurred.headers["content-type"]).toContain("image/jpeg");
        expect(blurred.headers["cache-control"]).toBe("no-store");
        const preview = await sharp(blurred.body as Buffer).metadata();
        expect(Math.max(preview.width ?? 0, preview.height ?? 0)).toBeLessThanOrEqual(32);

        const revealed = await asStaff(`${id}?reveal=1`);
        expect(revealed.headers["content-type"]).toContain("image/png");
        expect((await sharp(revealed.body as Buffer).metadata()).width).toBe(200);
    });

    it("are not sent a flagged video until they ask for it with ?reveal=1", async () => {
        const id = await storedVideo("flagged");
        const held = await request(app).get(`/api/auxiliary/media/${id}`).set(callerHeader(staff));
        expect(held.status).toBe(400);
        expect(held.body.error_code).toBe("media_held_for_review");

        const revealed = await asStaff(`${id}?reveal=1`);
        expect(revealed.status).toBe(200);
        expect(revealed.headers["content-type"]).toContain("video/mp4");
        expect((revealed.body as Buffer).subarray(4, 8).toString("latin1")).toBe("ftyp");
    });

    it("of another company get no held public file, even asking for the original", async () => {
        const otherCompanyStaff: TestCaller = {userId: new ObjectId().toString(), companyId: new ObjectId().toString()};
        for (const status of ["flagged", "rejected"]) {
            const id = await storedImage(status);
            for (const path of [id, `${id}?reveal=1`]) {
                const res = await request(app).get(`/api/auxiliary/media/${path}`).set(callerHeader(otherCompanyStaff));
                expect(res.body.error_code).toBe("media_not_found");
            }
        }
        const approved = await request(app).get(`/api/auxiliary/media/${await storedImage("approved")}`)
            .set(callerHeader(otherCompanyStaff)).buffer(true).parse(binary);
        expect((await sharp(approved.body as Buffer).metadata()).width).toBe(200);
    });

    it("see an image the review removed blurred, like a flagged one", async () => {
        const blurred = await asStaff(await storedImage("rejected"));
        expect(blurred.headers["content-type"]).toContain("image/jpeg");
    });

    it("get an image that is not flagged as it is", async () => {
        const res = await asStaff(await storedImage("passed"));
        expect((await sharp(res.body as Buffer).metadata()).width).toBe(200);
    });

    it("see the verdict in the file's info", async () => {
        const id = await storedImage("flagged");
        const info = await request(app).get(`/api/auxiliary/media/${id}/info`).set(callerHeader(staff));
        expect(JSON.stringify(info.body)).toContain("\"moderation\":\"flagged\"");
    });
});
