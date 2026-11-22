import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";

const ids = vi.hoisted(() => ({
    platform: "64b000000000000000000001",
    shop: "64b000000000000000000002",
    clinic: "64b000000000000000000003",
}));

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
vi.mock("@coreModule/connections/connectToWebSocketServer", async (importOriginal) => ({
    ...await importOriginal<typeof import("@coreModule/connections/connectToWebSocketServer")>(),
    pushWebsocketMessage: vi.fn(),
}));
vi.mock("@coreModule/domain/notifications/notificationEventBus", async (importOriginal) => ({
    ...await importOriginal<typeof import("@coreModule/domain/notifications/notificationEventBus")>(),
    emitNotificationEvent: vi.fn(),
}));

import {createHash} from "crypto";
import mongoose from "mongoose";
import {ObjectId} from "mongodb";
import {Readable} from "stream";
import request from "supertest";
import sharp from "sharp";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";
import {allPermissionTags, appFor, callerHeader, type TestCaller} from "@coreModule/_tests/httpHarness";
import {asCrossTenant, withTenant} from "@coreModule/utilities/endpoints/tenantScope";
import {emitNotificationEvent} from "@coreModule/domain/notifications/notificationEventBus";
import {pushWebsocketMessage} from "@coreModule/connections/connectToWebSocketServer";
import {getGridFSStorage} from "@coreModule/utilities/gridfs/gridfsStorage";
import {getLogger} from "@coreModule/loggers/serverLog";
import * as uploadReviewRoute from "@coreModule/api/auxiliary/private/uploadReview";
import * as privateMediaRoute from "@coreModule/api/auxiliary/private/media";
import Company from "@coreModule/database/schemas/company/company";
import Media from "@coreModule/database/schemas/media/media";
import Role from "@coreModule/database/schemas/role/role";
import RolePermission from "@coreModule/database/schemas/rolePermission/rolePermission";
import User from "@coreModule/database/schemas/user/user";
import UploadRefusal from "@coreModule/database/schemas/uploadRefusal/uploadRefusal";
import {notifyUploadsFlagged, recordUploadRefusal} from "@coreModule/domain/uploadReview/uploadReview";
import {actionPermissionTag} from "@coreModule/utilities/security/actionPermissions";

const platform = new ObjectId(ids.platform);
const shop = new ObjectId(ids.shop);
const clinic = new ObjectId(ids.clinic);
const reviewer = new ObjectId();
const uploader = new ObjectId();

const app = appFor([
    {...uploadReviewRoute, basePath: "/api/auxiliary/uploadReview"},
    {...privateMediaRoute, basePath: "/api/auxiliary/media"},
]);
const permissions = allPermissionTags([UploadRefusal]);
const REVIEW_TAG = actionPermissionTag(UploadRefusal, "reviewUploads", "self") ?? "";
const caller = (company: ObjectId, tags = permissions, userId = reviewer): TestCaller =>
    ({userId: userId.toString(), companyId: company.toString(), isAdmin: true, permissions: tags});
const platformReviewer = caller(platform);
const call = (who: TestCaller, path: string, body: object = {}) =>
    request(app).post(`/api/auxiliary/uploadReview${path}`).set(callerHeader(who)).send(body);
const notified = () => vi.mocked(emitNotificationEvent).mock.calls.map(([code, event]) => ({code, receiverIds: event.receiverIds, payload: event.payload}));
const pushed = () => vi.mocked(pushWebsocketMessage).mock.calls.map(([message]) => message);

/** Makes `reviewer` a member of the platform with a role that holds the review permission. */
async function platformReviewerRole(): Promise<void> {
    const permission = await RolePermission.collection.insertOne({tag: REVIEW_TAG, name: "Review uploads", group: "Uploadrefusals"});
    const role = await Role.collection.insertOne({company: platform, name: "Reviewers", isAdmin: false, permissions: [permission.insertedId]});
    await User.collection.updateOne({_id: reviewer}, {$set: {roles: [{company: platform, active: "active", roles: [role.insertedId]}]}});
}

const binary = (res: any, callback: (error: Error | null, body: Buffer) => void) => {
    const chunks: Buffer[] = [];
    res.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    res.on("end", () => callback(null, Buffer.concat(chunks)));
};
const getFile = (who: TestCaller, path: string) =>
    request(app).get(`/api/auxiliary/media/review/${path}`).set(callerHeader(who)).buffer(true).parse(binary);

/** A 200×120 PNG of `company`, with the content check's verdict. */
async function stored(company: ObjectId, status: string, extra: Record<string, unknown> = {}): Promise<ObjectId> {
    const png = await sharp({create: {width: 200, height: 120, channels: 3, background: "#336699"}}).png().toBuffer();
    const fileId = await getGridFSStorage("en-US", "media").uploadFile(Readable.from(png), "photo.png", {mimeType: "image/png"});
    const {insertedId} = await Media.collection.insertOne({
        type: "image", originalName: "photo.png", fileName: "photo.png", fileId: new ObjectId(fileId.toString()),
        mimeType: "image/png", extension: ".png", fileSize: png.length, isPublic: true, company, createdBy: uploader,
        createdAt: new Date(), deletedAt: null,
        metadata: {size: png.length, extension: ".png", mime: "image/png", safeCheckedFlag: false,
            moderation: {status, scores: {porn: 0.62, hentai: 0.01, sexy: 0.3, neutral: 0.07, drawing: 0}, checkedAt: new Date()}},
        ...extra,
    });
    return insertedId;
}

const moderationOf = async (id: ObjectId) => (await Media.collection.findOne({_id: id}))?.metadata?.moderation;

beforeAll(async () => {
    await connectTestDatabase();
}, 120000);

afterAll(async () => {
    await disconnectTestDatabase();
});

// The in-memory test database's collections this file writes (mongoGlobalSetup's MongoMemoryReplSet).
const FIXTURE_COLLECTIONS = [Company, Media, User, Role, RolePermission, UploadRefusal].map((model) => model.collection.name)
    .concat(["media.files", "media.chunks"]);

beforeEach(() => asCrossTenant("test fixtures span companies", async () => {
    vi.mocked(emitNotificationEvent).mockClear();
    vi.mocked(pushWebsocketMessage).mockClear();
    for (const name of FIXTURE_COLLECTIONS) {
        await mongoose.connection.db!.collection(name).deleteMany({});
    }
    await Company.collection.insertMany([
        {_id: platform, company: platform, name: "Kudoo", vat: "P-1", isPlatformOwner: true, isActive: true, modules: ["core"], deletedAt: null},
        {_id: shop, company: platform, name: "Kudoo Market", vat: "S-1", isActive: true, modules: ["core"], deletedAt: null},
        {_id: clinic, company: platform, name: "Clinic", vat: "C-1", isActive: true, modules: ["core"], deletedAt: null},
    ]);
    await User.collection.insertMany([
        {_id: reviewer, username: "rita@platform.test", fullName: "Rita Reviewer", companies: [platform]},
        {_id: uploader, username: "ana@shop.test", fullName: "Ana Shop", companies: [shop]},
    ]);
}));

describe("the platform's upload review lists (D177)", () => {
    it("lists every company's flagged files with names and counts, health files left out", async () => {
        const flagged = await stored(shop, "flagged");
        await stored(clinic, "flagged", {encrypted: true});
        await stored(shop, "passed");
        await stored(shop, "flagged", {deletedAt: new Date()});
        await withTenant(shop, () => recordUploadRefusal({
            bytes: Buffer.from("explicit bytes"), fileName: "nude.jpg", mimeType: "image/jpeg", errorCode: "file_explicit_content",
            scores: {porn: 0.97, hentai: 0, sexy: 0.02, neutral: 0.01, drawing: 0}, uploader: {companyId: shop, userId: uploader, route: "/api/blog"},
            logger: getLogger("upload-review-test"),
        }));

        const waiting = await call(platformReviewer, "/list", {view: "flagged"});
        expect(waiting.status).toBe(200);
        expect(waiting.body.counts).toEqual({flagged: 1, rejected: 0, approved: 0, refused: 1});
        expect(waiting.body.items).toEqual([expect.objectContaining({
            _id: flagged.toString(), kind: "media", fileName: "photo.png", status: "flagged", fileType: "image", isPublic: true, inUse: true,
            company: {_id: ids.shop, name: "Kudoo Market"}, uploadedBy: {_id: uploader.toString(), name: "Ana Shop"},
            scores: expect.objectContaining({porn: 0.62}),
        })]);

        const refused = await call(platformReviewer, "/list", {view: "refused"});
        expect(refused.body.items).toEqual([expect.objectContaining({
            kind: "refusal", fileName: "nude.jpg", status: "refused", company: {_id: ids.shop, name: "Kudoo Market"},
            fileHash: createHash("sha256").update("explicit bytes").digest("hex"),
            route: "/api/blog", refusalCode: "file_explicit_content",
        })]);
    });

    it("runs only in the platform company, and only with the review permission", async () => {
        const shopAdmin = caller(shop);
        expect((await call(shopAdmin, "/list", {view: "flagged"})).body.error_code).toBe("platform_company_required");
        const withoutPermission = caller(platform, permissions.filter((tag) => tag !== REVIEW_TAG));
        expect((await call(withoutPermission, "/list", {view: "flagged"})).body.error_code).toBe("user_permissions_not_sufficient");
        expect((await call(platformReviewer, "/list", {view: "everything"})).status).toBe(400);
    });
});

describe("the platform's upload review decisions (D177)", () => {
    it("approves and removes a file, each undoable, telling whoever uploaded it", async () => {
        const id = await stored(shop, "flagged");

        const approved = await call(platformReviewer, "/approve", {_id: id.toString()});
        expect(approved.status).toBe(200);
        expect(approved.body).toMatchObject({status: "approved", reviewedBy: {_id: reviewer.toString(), name: "Rita Reviewer"}});
        expect(await moderationOf(id)).toMatchObject({status: "approved", reviewedBy: reviewer, reviewedAt: expect.any(Date), scores: expect.objectContaining({porn: 0.62})});

        expect((await call(platformReviewer, "/remove", {_id: id.toString()})).body.status).toBe("rejected");
        expect((await moderationOf(id))?.status).toBe("rejected");
        expect((await call(platformReviewer, "/approve", {_id: id.toString()})).body.status).toBe("approved");

        expect(notified()).toEqual([
            {code: "UPLOAD_REVIEW_APPROVED", receiverIds: [uploader.toString()], payload: expect.objectContaining({companyId: ids.shop, name: "photo.png"})},
            {code: "UPLOAD_REVIEW_REMOVED", receiverIds: [uploader.toString()], payload: expect.objectContaining({companyId: ids.shop})},
            {code: "UPLOAD_REVIEW_APPROVED", receiverIds: [uploader.toString()], payload: expect.objectContaining({companyId: ids.shop})},
        ]);
    });

    it("refuses a decision the file is not waiting for, and never decides a health file", async () => {
        const approved = await stored(shop, "approved");
        const passed = await stored(shop, "passed");
        const health = await stored(clinic, "flagged", {encrypted: true});
        expect((await call(platformReviewer, "/approve", {_id: approved.toString()})).body.error_code).toBe("upload_review_not_open");
        expect((await call(platformReviewer, "/remove", {_id: passed.toString()})).body.error_code).toBe("upload_review_not_open");
        expect((await call(platformReviewer, "/remove", {_id: health.toString()})).body.error_code).toBe("media_not_found");
        expect((await moderationOf(health))?.status).toBe("flagged");
        expect((await call(caller(shop), "/approve", {_id: approved.toString()})).body.error_code).toBe("platform_company_required");
    });
});

describe("one file's sheet (D177)", () => {
    it("reads one file under review, for a notice's link, and nothing else", async () => {
        const unattached = await stored(shop, "flagged", {pendingReference: true});
        const res = await call(platformReviewer, "/single", {_id: unattached.toString()});
        expect(res.body).toMatchObject({_id: unattached.toString(), status: "flagged", inUse: false, company: {name: "Kudoo Market"}});

        for (const other of [await stored(shop, "passed"), await stored(clinic, "flagged", {encrypted: true})]) {
            expect((await call(platformReviewer, "/single", {_id: other.toString()})).body.error_code).toBe("media_not_found");
        }
        expect((await call(caller(shop), "/single", {_id: unattached.toString()})).body.error_code).toBe("platform_company_required");
    });
});

describe("the reviewed file (D177)", () => {
    it("is any company's file under review, blurred until the reviewer asks for it, never a health file", async () => {
        const flagged = await stored(shop, "flagged");
        const blurred = await getFile(platformReviewer, flagged.toString());
        expect(blurred.headers["content-type"]).toContain("image/jpeg");
        expect((await sharp(blurred.body as Buffer).metadata()).width).toBeLessThanOrEqual(32);
        const revealed = await getFile(platformReviewer, `${flagged}?reveal=1`);
        expect((await sharp(revealed.body as Buffer).metadata()).width).toBe(200);

        for (const other of [await stored(clinic, "flagged", {encrypted: true}), await stored(shop, "passed")]) {
            const res = await request(app).get(`/api/auxiliary/media/review/${other}`).set(callerHeader(platformReviewer));
            expect(res.body.error_code).toBe("media_not_found");
        }
        const fromShop = await request(app).get(`/api/auxiliary/media/review/${flagged}`).set(callerHeader(caller(shop)));
        expect(fromShop.body.error_code).toBe("platform_company_required");
    });
});

describe("notices to the platform's reviewers (D177)", () => {
    it("tells every reviewer, the uploader too, of one upload's flagged files in one notice, with the new counts", async () => {
        await platformReviewerRole();
        await stored(shop, "flagged");

        await notifyUploadsFlagged(
            [{mediaId: "m1", fileName: "beach.jpg"}, {mediaId: "m2", fileName: "pool.jpg"}],
            {companyName: "Kudoo Market", languageCode: "en-US"},
        );
        expect(notified()).toEqual([{
            code: "UPLOAD_FLAGGED",
            receiverIds: [reviewer.toString()],
            payload: expect.objectContaining({companyId: ids.platform, name: "beach.jpg", count: 2, variant: "several", uploaderCompanyName: "Kudoo Market"}),
        }]);
        expect(pushed()).toEqual([{code: "UPLOAD_REVIEW_COUNTS", payload: {counts: {flagged: 1, rejected: 0, approved: 0, refused: 0}}, userIds: [reviewer.toString()]}]);
    });

    it("gives the counts on request, and brings them live after a decision", async () => {
        await platformReviewerRole();
        const id = await stored(shop, "flagged");
        expect((await call(platformReviewer, "/counts")).body).toEqual({flagged: 1, rejected: 0, approved: 0, refused: 0});

        await call(platformReviewer, "/remove", {_id: id.toString()});
        expect(pushed()).toEqual([{code: "UPLOAD_REVIEW_COUNTS", payload: {counts: {flagged: 0, rejected: 1, approved: 0, refused: 0}}, userIds: [reviewer.toString()]}]);
        expect((await call(caller(shop), "/counts")).body.error_code).toBe("platform_company_required");
    });

    it("says nothing when nothing was flagged or no one reviews", async () => {
        await notifyUploadsFlagged([], {companyName: "Kudoo Market", languageCode: "en-US"});
        await notifyUploadsFlagged([{mediaId: "m1", fileName: "beach.jpg"}], {companyName: "Kudoo Market", languageCode: "en-US"});
        expect(notified()).toEqual([]);
        expect(pushed()).toEqual([]);
        expect(await UploadRefusal.collection.countDocuments()).toBe(0);
    });
});
