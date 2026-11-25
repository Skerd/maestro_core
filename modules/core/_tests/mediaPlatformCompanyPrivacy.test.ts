import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";

const ids = vi.hoisted(() => ({platform: "64b000000000000000000001", clinic: "64b000000000000000000002", shop: "64b000000000000000000003"}));

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

// Portal accounts all sign in to the platform company; they are strangers to each other (D189).
const patient: TestCaller = {userId: new ObjectId().toString(), companyId: ids.platform};
const otherPortalUser: TestCaller = {userId: new ObjectId().toString(), companyId: ids.platform};
const clinicStaff: TestCaller = {userId: new ObjectId().toString(), companyId: ids.clinic};
const shopStaff: TestCaller = {userId: new ObjectId().toString(), companyId: ids.shop};
const shopColleague: TestCaller = {userId: new ObjectId().toString(), companyId: ids.shop};

const uploads = express.Router();
uploads.post(
    "/",
    authMW("private"),
    (req: Request, _res: Response, next: NextFunction) => {
        req.body.userInfo = {_id: new ObjectId(req.body.actionUserCtx.userId)};
        req.body.user = {company: {_id: req.body.company._id}};
        next();
    },
    mediaUploadMW({fields: {files: 1}, enableSecurityScan: false, sanitizeImages: false}),
    (req: Request, res: Response) => res.json({files: req.body.files}),
);
const app = appFor([{basePath: "/test/upload", router: uploads}, {...mediaRoute, basePath: "/api/auxiliary/media"}]);

async function upload(caller: TestCaller): Promise<string> {
    const png = await sharp({create: {width: 4, height: 4, channels: 3, background: "#336699"}}).png().toBuffer();
    const uploaded = await request(app).post("/test/upload").set(callerHeader(caller))
        .attach("files", png, {filename: "x-ray.png", contentType: "image/png"});
    expect(uploaded.status).toBe(200);
    // A one-file field answers the id itself, not a list
    return uploaded.body.files as string;
}

async function opens(caller: TestCaller, mediaId: string): Promise<boolean> {
    const file = await request(app).get(`/api/auxiliary/media/${mediaId}`).set(callerHeader(caller));
    const info = await request(app).get(`/api/auxiliary/media/${mediaId}/info`).set(callerHeader(caller));
    expect(file.status === 200).toBe(info.status === 200);
    return file.status === 200;
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

describe("private files in the platform company", () => {
    it("open for the portal account that uploaded them, never for another portal account", async () => {
        const xRay = await upload(patient);

        expect(await opens(patient, xRay)).toBe(true);
        expect(await opens(otherPortalUser, xRay)).toBe(false);
        const refused = await request(app).get(`/api/auxiliary/media/${xRay}/info`).set(callerHeader(otherPortalUser));
        expect(refused.body.error_code).toBe("media_not_found");
    });

    it("still open for a company the file was shared with", async () => {
        const xRay = await upload(patient);
        await withTenant(new ObjectId(ids.platform), () =>
            Media.updateOne({_id: new ObjectId(xRay)}, {$set: {sharedWithCompanies: [new ObjectId(ids.clinic)]}}));

        expect(await opens(clinicStaff, xRay)).toBe(true);
        expect(await opens(otherPortalUser, xRay)).toBe(false);
    });

    it("stay open for everyone when the platform made them public", async () => {
        const logo = await upload(patient);
        await withTenant(new ObjectId(ids.platform), () => Media.updateOne({_id: new ObjectId(logo)}, {$set: {isPublic: true}}));

        expect(await opens(otherPortalUser, logo)).toBe(true);
    });
});

describe("private files in any other company", () => {
    it("open for every member of the company, as before", async () => {
        const invoice = await upload(shopStaff);

        expect(await opens(shopColleague, invoice)).toBe(true);
        expect(await opens(otherPortalUser, invoice)).toBe(false);
    });
});
