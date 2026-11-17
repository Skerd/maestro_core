import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";

vi.mock("@coreModule/utilities/middlewares/authMW", async () =>
    (await import("@coreModule/_tests/httpHarness")).authMWStub);
vi.mock("@coreModule/utilities/middlewares/rateLimiter", () => ({
    rateLimiter: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import {ObjectId} from "mongodb";
import express, {NextFunction, Request, Response} from "express";
import request from "supertest";
import sharp from "sharp";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";
import {appFor, callerHeader, type TestCaller} from "@coreModule/_tests/httpHarness";
import Media from "@coreModule/database/schemas/media/media";
import * as mediaRoute from "@coreModule/api/auxiliary/private/media";
import authMW from "@coreModule/utilities/middlewares/authMW";
import {mediaUploadMW} from "@coreModule/utilities/middlewares/mediaUploadMW";
import {withTenant} from "@coreModule/utilities/endpoints/tenantScope";

// The platform's company list and the company switcher show other companies' logos (public media).
const platform: TestCaller = {userId: new ObjectId().toString(), companyId: new ObjectId().toString()};
const shop: TestCaller = {userId: new ObjectId().toString(), companyId: new ObjectId().toString()};

const uploads = express.Router();
uploads.post(
    "/",
    authMW("private"),
    (req: Request, _res: Response, next: NextFunction) => {
        req.body.userInfo = {_id: new ObjectId(shop.userId)};
        req.body.user = {company: {_id: new ObjectId(shop.companyId)}};
        next();
    },
    mediaUploadMW({fields: {files: 2}, enableSecurityScan: false, sanitizeImages: false}),
    (req: Request, res: Response) => res.json({files: req.body.files}),
);
const app = appFor([{basePath: "/test/upload", router: uploads}, {...mediaRoute, basePath: "/api/auxiliary/media"}]);

async function shopUploadsTwoImages(): Promise<{logo: string; invoice: string}> {
    const png = await sharp({create: {width: 4, height: 4, channels: 3, background: "#336699"}}).png().toBuffer();
    const uploaded = await request(app).post("/test/upload").set(callerHeader(shop))
        .attach("files", png, {filename: "logo.png", contentType: "image/png"})
        .attach("files", png, {filename: "invoice.png", contentType: "image/png"});
    expect(uploaded.status).toBe(200);
    const [logo, invoice] = uploaded.body.files as string[];
    await withTenant(new ObjectId(shop.companyId), () => Media.updateOne({_id: new ObjectId(logo)}, {$set: {isPublic: true}}));
    return {logo, invoice};
}

beforeAll(async () => {
    await connectTestDatabase();
}, 120000);

afterAll(async () => {
    await disconnectTestDatabase();
});

beforeEach(async () => {
    await Media.collection.deleteMany({});
});

describe("signed-in media across companies", () => {
    it("serves another company's public file, such as its logo", async () => {
        const {logo} = await shopUploadsTwoImages();

        const file = await request(app).get(`/api/auxiliary/media/${logo}`).set(callerHeader(platform));
        expect(file.status).toBe(200);
        expect(file.headers["content-type"]).toContain("image/png");

        const info = await request(app).get(`/api/auxiliary/media/${logo}/info`).set(callerHeader(platform));
        expect(info.status).toBe(200);
    });

    it("still does not find another company's private file", async () => {
        const {invoice} = await shopUploadsTwoImages();

        const file = await request(app).get(`/api/auxiliary/media/${invoice}`).set(callerHeader(platform));
        expect(file.body.error_code).toBe("media_not_found");

        const info = await request(app).get(`/api/auxiliary/media/${invoice}/info`).set(callerHeader(platform));
        expect(info.body.error_code).toBe("media_not_found");
    });

    it("keeps serving the company's own private file", async () => {
        const {invoice} = await shopUploadsTwoImages();

        const file = await request(app).get(`/api/auxiliary/media/${invoice}`).set(callerHeader(shop));
        expect(file.status).toBe(200);
    });
});
