import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";

vi.mock("@coreModule/utilities/middlewares/authMW", async () =>
    (await import("@coreModule/_tests/httpHarness")).authMWStub);

// A fake nudity detector (BE-09): each test sets the scores it answers, or makes it fail (D177).
const {detector} = vi.hoisted(() => ({
    detector: {scores: {porn: 0, hentai: 0, sexy: 0, neutral: 1, drawing: 0}, fail: false, frames: 0},
}));
vi.mock("@coreModule/utilities/security/contentModerator", async (importOriginal) => ({
    ...await importOriginal<typeof import("@coreModule/utilities/security/contentModerator")>(),
    contentModerator: () => ({
        scoreFrame: async (rgb: Buffer) => {
            detector.frames++;
            if (rgb.length !== 224 * 224 * 3) throw new Error(`expected a 224×224 RGB frame, got ${rgb.length} bytes`);
            if (detector.fail) throw new Error("the detector is down");
            return {...detector.scores};
        },
    }),
}));

// Notices to the platform's reviewers are checked where they are built (uploadReview.test.ts); here, only that uploads send them.
vi.mock("@coreModule/domain/uploadReview/uploadReview", async (importOriginal) => ({
    ...await importOriginal<typeof import("@coreModule/domain/uploadReview/uploadReview")>(),
    notifyUploadsFlagged: vi.fn(async () => undefined),
}));

import {createHash} from "crypto";
import {ObjectId} from "mongodb";
import mongoose from "mongoose";
import express, {NextFunction, Request, Response} from "express";
import request from "supertest";
import sharp from "sharp";
import AdmZip from "adm-zip";
import {PDFArray, PDFDict, PDFDocument, PDFName, PDFString} from "pdf-lib";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";
import {appFor, callerHeader, type TestCaller} from "@coreModule/_tests/httpHarness";
import Media from "@coreModule/database/schemas/media/media";
import authMW from "@coreModule/utilities/middlewares/authMW";
import {mediaUploadMW, UnifiedMediaUploadOptions} from "@coreModule/utilities/middlewares/mediaUploadMW";
import {asyncHandler} from "@coreModule/utilities/middlewares/asyncHandler";
import {transactionHandler} from "@coreModule/utilities/middlewares/transactionHandler";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import type {ClientSession} from "mongoose";
import {getGridFSStorage} from "@coreModule/utilities/gridfs/gridfsStorage";
import {FILE_UPLOAD} from "@coreModule/environment";
import UploadRefusal from "@coreModule/database/schemas/uploadRefusal/uploadRefusal";
import {notifyUploadsFlagged} from "@coreModule/domain/uploadReview/uploadReview";
import {testVideo} from "@coreModule/_tests/testVideo";

// The scanner comes from the developer's .env; these tests use the mock, whatever is configured there.
FILE_UPLOAD.FILE_SCANNER_TYPE = "mock";
FILE_UPLOAD.MOCK_SCANNER_SIMULATE_THREATS = false;

const caller: TestCaller = {userId: new ObjectId().toString(), companyId: new ObjectId().toString()};

function uploadRouter(options: UnifiedMediaUploadOptions) {
    const router = express.Router();
    router.post("/", authMW("private"),
        // What authMW writes for the signed-in caller.
        (req: Request, _res: Response, next: NextFunction) => {
            req.body.userInfo = {_id: new ObjectId(caller.userId)};
            req.body.user = {company: {_id: new ObjectId(caller.companyId)}};
            req.body.company = {_id: new ObjectId(caller.companyId)};
            next();
        },
        mediaUploadMW(options),
        (req: Request, res: Response) => res.json({
            files: req.body.files,
            userId: String(req.body.userInfo?._id),
            userCompany: String(req.body.user?.company?._id),
            company: String(req.body.company?._id),
        }));
    return router;
}

/** An action without a transaction whose own work fails after the upload succeeded. */
const failingAfterUpload = express.Router();
failingAfterUpload.post("/", authMW("private"),
    (req: Request, _res: Response, next: NextFunction) => {
        req.body.userInfo = {_id: new ObjectId(caller.userId)};
        req.body.user = {company: {_id: new ObjectId(caller.companyId)}};
        next();
    },
    mediaUploadMW({fields: {files: 3}}),
    asyncHandler(async () => {
        throw new Error("the record could not be saved");
    }));

/** A middleware after the upload refuses the request, as validateFormZod does with an invalid form (TD-B251). */
const refuseForm = (_req: Request, _res: Response, next: NextFunction) =>
    next(apiValidationException("form_not_correct", null, null, "en-US"));
let lastSession: ClientSession | undefined;
function refusingAfterUpload(withTransaction: boolean) {
    const router = express.Router();
    router.post("/", authMW("private"),
        ...(withTransaction ? [transactionHandler()] : []),
        (req: Request, _res: Response, next: NextFunction) => {
            req.body.userInfo = {_id: new ObjectId(caller.userId)};
            req.body.user = {company: {_id: new ObjectId(caller.companyId)}};
            lastSession = req.body.session;
            next();
        },
        mediaUploadMW({fields: {files: 3}}),
        refuseForm,
        asyncHandler(async () => ({never: "reached"})));
    return router;
}

const app = appFor([
    {basePath: "/upload-then-refuse", router: refusingAfterUpload(false)},
    {basePath: "/upload-in-transaction-then-refuse", router: refusingAfterUpload(true)},
    {basePath: "/upload-then-fail", router: failingAfterUpload},
    {basePath: "/upload", router: uploadRouter({fields: {files: 3}})},
    {basePath: "/upload-small", router: uploadRouter({fields: {files: 3}, maxFileSize: 2 * 1024})},
    {basePath: "/upload-images", router: uploadRouter({fields: {files: 3}, fieldMimeTypes: {files: ["image/jpeg", "image/png"]}})},
    {basePath: "/upload-health", router: uploadRouter({fields: {files: 3}, healthData: true})},
]);

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const upload = (files: {data: Buffer; name: string; type: string}[], path = "/upload") =>
    files.reduce((req, file) => req.attach("files", file.data, {filename: file.name, contentType: file.type}),
        request(app).post(path).set(callerHeader(caller)));

async function storedFile(mediaId: string) {
    const media = await Media.collection.findOne({_id: new ObjectId(mediaId)});
    if (!media) throw new Error(`Media ${mediaId} was not stored`);
    const bytes = await getGridFSStorage("en-US", "media").getFileBuffer(String(media.fileId));
    return {media, bytes};
}

const png = () => sharp({create: {width: 4, height: 4, channels: 3, background: "#336699"}}).png().toBuffer();

/** A minimal OLE2 compound file (512-byte sectors: the FAT in sector 0, the directory in sector 1) with these entries. */
function oleFile(entries: {name: string; type: 1 | 2}[]): Buffer {
    const sectorSize = 512;
    const header = Buffer.alloc(sectorSize);
    Buffer.from("d0cf11e0a1b11ae1", "hex").copy(header, 0);
    header.writeUInt16LE(0x3E, 24);
    header.writeUInt16LE(3, 26);
    header.writeUInt16LE(0xFFFE, 28);
    header.writeUInt16LE(9, 30);
    header.writeUInt16LE(6, 32);
    header.writeUInt32LE(1, 44); // one FAT sector
    header.writeUInt32LE(1, 48); // the directory starts at sector 1
    header.writeUInt32LE(4096, 56);
    header.writeUInt32LE(0xFFFFFFFE, 60);
    header.writeUInt32LE(0xFFFFFFFE, 68);
    for (let slot = 0; slot < 109; slot++) header.writeUInt32LE(slot === 0 ? 0 : 0xFFFFFFFF, 76 + slot * 4);
    const fat = Buffer.alloc(sectorSize, 0xFF);
    fat.writeUInt32LE(0xFFFFFFFD, 0); // sector 0 holds the FAT
    fat.writeUInt32LE(0xFFFFFFFE, 4); // sector 1, the directory, ends its chain
    const directory = Buffer.alloc(sectorSize);
    [{name: "Root Entry", type: 5}, ...entries].forEach((entry, index) => {
        const name = Buffer.from(`${entry.name}\0`, "utf16le");
        name.copy(directory, index * 128);
        directory.writeUInt16LE(name.length, index * 128 + 64);
        directory[index * 128 + 66] = entry.type;
    });
    return Buffer.concat([header, fat, directory]);
}

function ooxml(parts: Record<string, Buffer | string>): Buffer {
    const zip = new AdmZip();
    zip.addFile("[Content_Types].xml", Buffer.from("<Types/>"));
    for (const [name, data] of Object.entries(parts)) zip.addFile(name, Buffer.isBuffer(data) ? data : Buffer.from(data));
    return zip.toBuffer();
}

beforeAll(async () => {
    await connectTestDatabase();
}, 120000);

afterAll(async () => {
    await disconnectTestDatabase();
});

beforeEach(async () => {
    await Media.collection.deleteMany({});
    await UploadRefusal.collection.deleteMany({});
    vi.mocked(notifyUploadsFlagged).mockClear();
    detector.scores = {porn: 0, hentai: 0, sexy: 0, neutral: 1, drawing: 0};
    detector.fail = false;
    detector.frames = 0;
});

describe("content moderation (D177)", () => {
    it("refuses an image with a clear explicit score and stores nothing", async () => {
        detector.scores = {porn: 0.93, hentai: 0.02, sexy: 0.04, neutral: 0.01, drawing: 0};
        const res = await upload([{data: await png(), name: "photo.png", type: "image/png"}]);
        expect(res.status).toBe(400);
        expect(res.body.error_code).toBe("file_explicit_content");
        expect(await Media.collection.countDocuments()).toBe(0);
    });

    it("stores a borderline image flagged, with its scores", async () => {
        detector.scores = {porn: 0.62, hentai: 0.01, sexy: 0.3, neutral: 0.07, drawing: 0};
        const res = await upload([{data: await png(), name: "photo.png", type: "image/png"}]);
        expect(res.status).toBe(200);
        const {media} = await storedFile(res.body.files[0]);
        expect(media.metadata.moderation).toMatchObject({status: "flagged", scores: {porn: 0.62}});
    });

    it("records an ordinary image as passed", async () => {
        const res = await upload([{data: await png(), name: "photo.png", type: "image/png"}]);
        expect((await storedFile(res.body.files[0])).media.metadata.moderation.status).toBe("passed");
    });

    it("only flags a health file, even with a clear score", async () => {
        detector.scores = {porn: 0.97, hentai: 0, sexy: 0.02, neutral: 0.01, drawing: 0};
        const res = await upload([{data: await png(), name: "intraoral.png", type: "image/png"}], "/upload-health");
        expect(res.status).toBe(200);
        expect((await storedFile(res.body.files[0])).media.metadata.moderation.status).toBe("flagged");
    });

    it("refuses when the detector cannot run, but stores a health file as not checked", async () => {
        detector.fail = true;
        const refused = await upload([{data: await png(), name: "photo.png", type: "image/png"}]);
        expect(refused.body.error_code).toBe("file_moderation_unavailable");
        const health = await upload([{data: await png(), name: "xray.png", type: "image/png"}], "/upload-health");
        expect(health.status).toBe(200);
        expect((await storedFile(health.body.files[0])).media.metadata.moderation.status).toBe("not_checked");
    });

    it("scores the frames of an animation and a grayscale X-ray as RGB", async () => {
        const frame = (color: string) => sharp({create: {width: 8, height: 8, channels: 3, background: color}}).png().toBuffer();
        const gif = await sharp([await frame("#f00"), await frame("#00f")], {join: {animated: true}}).gif().toBuffer();
        await upload([{data: gif, name: "spinner.gif", type: "image/gif"}]);
        expect(detector.frames).toBe(2);
        const xray = await sharp({create: {width: 8, height: 8, channels: 3, background: "#777"}}).toColourspace("b-w").png().toBuffer();
        const res = await upload([{data: xray, name: "xray.png", type: "image/png"}]);
        expect(res.status).toBe(200);
    });

    it("does not check files that are neither images nor videos", async () => {
        const res = await upload([{data: Buffer.from("hello"), name: "notes.txt", type: "text/plain"}]);
        expect(detector.frames).toBe(0);
        expect((await storedFile(res.body.files[0])).media.metadata.moderation).toBeUndefined();
    });
});

describe("the platform's upload review (D177)", () => {
    it("logs a refused upload for review: who, where, scores and fingerprint, never the file", async () => {
        detector.scores = {porn: 0.93, hentai: 0.02, sexy: 0.04, neutral: 0.01, drawing: 0};
        const bytes = await png();
        const res = await upload([{data: bytes, name: "photo.png", type: "image/png"}]);
        expect(res.body.error_code).toBe("file_explicit_content");
        const refusals = await UploadRefusal.collection.find({}).toArray();
        expect(refusals).toEqual([expect.objectContaining({
            fileName: "photo.png", mimeType: "image/png", route: "/upload", errorCode: "file_explicit_content",
            company: new ObjectId(caller.companyId), createdBy: new ObjectId(caller.userId),
            scores: expect.objectContaining({porn: 0.93}),
        })]);
        // The fingerprint of the file as it was sent, to recognise it again.
        expect(refusals[0]).toMatchObject({fileHash: createHash("sha256").update(bytes).digest("hex"), fileSize: bytes.length});
        expect(await Media.collection.countDocuments()).toBe(0);
    });

    it("announces the flagged files of an upload once, but never a health file's", async () => {
        detector.scores = {porn: 0.62, hentai: 0.01, sexy: 0.3, neutral: 0.07, drawing: 0};
        const res = await upload([
            {data: await png(), name: "beach.png", type: "image/png"},
            {data: await png(), name: "pool.png", type: "image/png"},
        ]);
        expect(vi.mocked(notifyUploadsFlagged)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(notifyUploadsFlagged).mock.calls[0][0]).toEqual([
            {mediaId: res.body.files[0], fileName: "beach.png"},
            {mediaId: res.body.files[1], fileName: "pool.png"},
        ]);

        vi.mocked(notifyUploadsFlagged).mockClear();
        await upload([{data: await png(), name: "xray.png", type: "image/png"}], "/upload-health");
        expect(vi.mocked(notifyUploadsFlagged).mock.calls[0][0]).toEqual([]);
    });
});

describe("content moderation of documents (D177)", () => {
    const photo = () => sharp({create: {width: 300, height: 300, channels: 3, background: "#cc3355"}}).png().toBuffer();
    const pdfWithPhoto = async () => {
        const pdf = await PDFDocument.create();
        pdf.addPage([400, 400]).drawImage(await pdf.embedPng(await photo()), {x: 50, y: 50, width: 300, height: 300});
        return Buffer.from(await pdf.save());
    };
    const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

    it("refuses a PDF whose page looks explicit, and logs it", async () => {
        detector.scores = {porn: 0.92, hentai: 0, sexy: 0.05, neutral: 0.03, drawing: 0};
        const res = await upload([{data: await pdfWithPhoto(), name: "brochure.pdf", type: "application/pdf"}]);
        expect(res.status).toBe(400);
        expect(res.body.error_code).toBe("document_explicit_content");
        expect(detector.frames).toBeGreaterThan(0);
        expect(await UploadRefusal.collection.findOne({})).toMatchObject({fileName: "brochure.pdf", errorCode: "document_explicit_content"});
        expect(await Media.collection.countDocuments()).toBe(0);
    });

    it("stores a .docx with a borderline picture flagged, and one without pictures as passed", async () => {
        detector.scores = {porn: 0.6, hentai: 0, sexy: 0.3, neutral: 0.1, drawing: 0};
        const flagged = await upload([{data: ooxml({"word/document.xml": "<w:document/>", "word/media/image1.png": await photo()}), name: "offer.docx", type: DOCX}]);
        expect((await storedFile(flagged.body.files[0])).media.metadata.moderation).toMatchObject({status: "flagged", scores: {porn: 0.6}});

        detector.frames = 0;
        const plain = await upload([{data: ooxml({"word/document.xml": "<w:document/>"}), name: "letter.docx", type: DOCX}]);
        expect(detector.frames).toBe(0);
        expect((await storedFile(plain.body.files[0])).media.metadata.moderation.status).toBe("passed");
    });

    it("stores a 97-2003 Office file, whose pictures it does not read, as not checked", async () => {
        const res = await upload([{data: oleFile([{name: "WordDocument", type: 2}]), name: "letter.doc", type: "application/msword"}]);
        expect(res.status).toBe(200);
        expect((await storedFile(res.body.files[0])).media.metadata.moderation.status).toBe("not_checked");
    });
});

describe("content moderation of videos (D177)", () => {
    it("refuses a video with a clear explicit score, after scoring frames spread over it", async () => {
        detector.scores = {porn: 0.91, hentai: 0, sexy: 0.08, neutral: 0.01, drawing: 0};
        const res = await upload([{data: testVideo(6), name: "clip.mp4", type: "video/mp4"}]);
        expect(res.status).toBe(400);
        expect(res.body.error_code).toBe("video_explicit_content");
        expect(detector.frames).toBe(3);
        expect(await Media.collection.countDocuments()).toBe(0);
    });

    it("stores a borderline video flagged, and an ordinary one as passed", async () => {
        detector.scores = {porn: 0.6, hentai: 0, sexy: 0.35, neutral: 0.05, drawing: 0};
        const flagged = await upload([{data: testVideo(2), name: "clip.mp4", type: "video/mp4"}]);
        expect(flagged.status).toBe(200);
        expect((await storedFile(flagged.body.files[0])).media.metadata.moderation).toMatchObject({status: "flagged", scores: {porn: 0.6}});
        detector.scores = {porn: 0, hentai: 0, sexy: 0, neutral: 1, drawing: 0};
        const passed = await upload([{data: testVideo(2), name: "tour.mp4", type: "video/mp4"}]);
        expect((await storedFile(passed.body.files[0])).media.metadata.moderation.status).toBe("passed");
    });

    it("refuses a video it cannot read, saying so, but stores a health video as not checked", async () => {
        const broken = Buffer.concat([Buffer.from("000000186674797069736f6d0000020069736f6d", "hex"), Buffer.alloc(400)]);
        const refused = await upload([{data: broken, name: "clip.mp4", type: "video/mp4"}]);
        expect(refused.status).toBe(400);
        expect(refused.body.error_code).toBe("video_unreadable");
        const health = await upload([{data: broken, name: "scan.mp4", type: "video/mp4"}], "/upload-health");
        expect(health.status).toBe(200);
        expect((await storedFile(health.body.files[0])).media.metadata.moderation.status).toBe("not_checked");
    });

    it("only flags a health video, even with a clear score", async () => {
        detector.scores = {porn: 0.95, hentai: 0, sexy: 0.04, neutral: 0.01, drawing: 0};
        const res = await upload([{data: testVideo(2), name: "intraoral.mp4", type: "video/mp4"}], "/upload-health");
        expect(res.status).toBe(200);
        expect((await storedFile(res.body.files[0])).media.metadata.moderation.status).toBe("flagged");
    });
});

describe("a refused file reaches the caller", () => {
    it("refuses a blocked type instead of saving the request without it", async () => {
        const res = await upload([{data: Buffer.from("MZ fake"), name: "setup.exe", type: "application/x-msdownload"}]);
        expect(res.status).toBe(400);
        expect(res.body.error_code).toBe("file_type_blocked");
    });

    it("refuses a file over the size limit, naming the limit", async () => {
        const res = await upload([{data: Buffer.alloc(3 * 1024, 65), name: "notes.txt", type: "text/plain"}], "/upload-small");
        expect(res.body.error_code).toBe("file_too_large");
        expect(res.body.message).toBe("This file is larger than the 2 KB upload limit.");
    });

    it("lists the types a field accepts when refusing another", async () => {
        const res = await upload([{data: Buffer.from("%PDF-1.4"), name: "scan.pdf", type: "application/pdf"}], "/upload-images");
        expect(res.body.error_code).toBe("file_type_not_allowed");
        expect(res.body.message).toBe("This type of file can't be uploaded here. Accepted: .jpg, .jpeg, .png.");
    });

    it("names the threat the virus scan found", async () => {
        FILE_UPLOAD.MOCK_SCANNER_SIMULATE_THREATS = true;
        try {
            const res = await upload([{data: Buffer.from("hello"), name: "malicious.txt", type: "text/plain"}]);
            expect(res.body.error_code).toBe("file_contains_malware");
            expect(res.body.message).toBe("The virus scan found a threat in this file (Mock threat), so it was not uploaded.");
        } finally {
            FILE_UPLOAD.MOCK_SCANNER_SIMULATE_THREATS = false;
        }
    });

    it("refuses more files than the field takes", async () => {
        const file = {data: Buffer.from("hello"), name: "a.txt", type: "text/plain"};
        const res = await upload([file, file, file, file]);
        expect(res.body.error_code).toBe("too_many_files");
    });

    it("stores none of a request's files when one is refused", async () => {
        const res = await upload([
            {data: await png(), name: "ok.png", type: "image/png"},
            {data: Buffer.from("MZ fake"), name: "setup.exe", type: "application/x-msdownload"},
        ]);
        expect(res.status).toBe(400);
        expect(await Media.collection.countDocuments()).toBe(0);
    });

    it("deletes files already stored when a later one fails its checks", async () => {
        const db = mongoose.connection.db!;
        const filesBefore = await db.collection("media.files").countDocuments();
        const res = await upload([
            {data: await png(), name: "first.png", type: "image/png"},
            {data: oleFile([{name: "WordDocument", type: 2}, {name: "Macros", type: 1}]), name: "macro.doc", type: "application/msword"},
        ]);
        expect(res.body.error_code).toBe("office_document_validation_failed");
        expect(await Media.collection.countDocuments()).toBe(0);
        expect(await db.collection("media.files").countDocuments()).toBe(filesBefore);
    });
});

describe("server-owned request keys (SEC-03)", () => {
    it("keeps the signed-in user and company when the form claims others", async () => {
        const other = new ObjectId().toString();
        const res = await request(app).post("/upload").set(callerHeader(caller))
            .field("data", JSON.stringify({user: {company: {_id: other}}, userInfo: {_id: other}, _mediaUploadGridFsIds: ["x"]}))
            .field("company", other)
            .attach("files", await png(), {filename: "a.png", contentType: "image/png"});
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({userId: caller.userId, userCompany: caller.companyId, company: caller.companyId});
        const {media} = await storedFile(res.body.files[0]);
        expect(String(media.company)).toBe(caller.companyId);
        expect(String(media.createdBy)).toBe(caller.userId);
    });

    it("keeps them when the form carries no file", async () => {
        const other = new ObjectId().toString();
        const res = await request(app).post("/upload").set(callerHeader(caller))
            .field("data", JSON.stringify({user: {company: {_id: other}, isAdmin: true}, userInfo: {_id: other}}))
            .field("company", other);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({userId: caller.userId, userCompany: caller.companyId, company: caller.companyId});
    });
});

describe("a route that fails after its upload, without a transaction (TD-B249)", () => {
    it("hands the uploaded files to the orphan cleanup", async () => {
        const res = await upload([{data: await png(), name: "photo.png", type: "image/png"}], "/upload-then-fail");
        expect(res.status).toBe(500);
        const stored = await Media.collection.find({}).toArray();
        expect(stored).toHaveLength(1);
        expect(stored[0].pendingReference).toBe(true);
    });

    it("cannot be pointed at someone else's file by the client", async () => {
        const {insertedId} = await Media.collection.insertOne({type: "image", originalName: "theirs.png", company: new ObjectId()});
        const res = await request(app).post("/upload-then-fail").set(callerHeader(caller))
            .field("data", JSON.stringify({_mediaUploadMediaIds: [insertedId.toString()]}))
            .attach("files", await png(), {filename: "mine.png", contentType: "image/png"});
        expect(res.status).toBe(500);
        expect((await Media.collection.findOne({_id: insertedId}))?.pendingReference).toBeUndefined();
    });
});

describe("a middleware that refuses the request after its upload (TD-B251)", () => {
    it("hands the uploads to the orphan cleanup when there is no transaction", async () => {
        const res = await upload([{data: await png(), name: "photo.png", type: "image/png"}], "/upload-then-refuse");
        expect(res.body.error_code).toBe("form_not_correct");
        const stored = await Media.collection.find({}).toArray();
        expect(stored).toHaveLength(1);
        expect(stored[0].pendingReference).toBe(true);
    });

    it("rolls back an open transaction, deletes its files and ends the session", async () => {
        const db = mongoose.connection.db!;
        const filesBefore = await db.collection("media.files").countDocuments();
        const res = await upload([{data: await png(), name: "photo.png", type: "image/png"}], "/upload-in-transaction-then-refuse");
        expect(res.body.error_code).toBe("form_not_correct");
        expect(await Media.collection.countDocuments()).toBe(0);
        expect(await db.collection("media.files").countDocuments()).toBe(filesBefore);
        expect(lastSession?.hasEnded).toBe(true);
    });
});

describe("the extension decides the type", () => {
    it("refuses extensions outside the list, whatever type the browser sends", async () => {
        const hta = await upload([{data: Buffer.from("<script>run()</script>"), name: "invoice.pdf.hta", type: "text/plain"}]);
        const trailingDot = await upload([{data: Buffer.from("MZ"), name: "setup.exe.", type: "text/plain"}]);
        expect(hta.body.error_code).toBe("file_type_not_allowed");
        expect(trailingDot.body.error_code).toBe("file_type_not_allowed");
    });

    it("refuses binary bytes in a text file", async () => {
        const res = await upload([{data: Buffer.concat([Buffer.from("MZ"), Buffer.alloc(64)]), name: "notes.txt", type: "text/plain"}]);
        expect(res.body.error_code).toBe("file_content_does_not_match_type");
    });

    it("names a file without an extension after its type", async () => {
        const res = await upload([{data: await png(), name: "pasted", type: "image/png"}]);
        expect(res.status).toBe(200);
        const {media} = await storedFile(res.body.files[0]);
        expect(media.originalName).toBe("pasted.png");
    });
});

describe("files people upload every day", () => {
    it("accepts an iPhone or screen-recording video (an ftyp box of any size)", async () => {
        const mov = testVideo(1, "mov");
        expect(mov.subarray(4, 12).toString("latin1")).toBe("ftypqt  ");
        const res = await upload([{data: mov, name: "IMG_0496.MOV", type: "video/quicktime"}]);
        expect(res.status).toBe(200);
        expect((await storedFile(res.body.files[0])).media.mimeType).toBe("video/quicktime");
    });

    it("accepts Office 97-2003 files without macros and refuses those with macros or packaged files", async () => {
        const doc = await upload([{data: oleFile([{name: "WordDocument", type: 2}]), name: "letter.doc", type: "application/msword"}]);
        const xlsMacros = await upload([{data: oleFile([{name: "Workbook", type: 2}, {name: "_VBA_PROJECT_CUR", type: 1}]), name: "sheet.xls", type: "application/vnd.ms-excel"}]);
        const packaged = await upload([{data: oleFile([{name: "WordDocument", type: 2}, {name: "\u0001Ole10Native", type: 2}]), name: "invoice.doc", type: "application/msword"}]);
        expect(doc.status).toBe(200);
        expect(xlsMacros.body.error_code).toBe("office_document_validation_failed");
        expect(packaged.body.error_code).toBe("office_document_validation_failed");
    });

    it("accepts a .docx with a chart and an .xlsx with printer settings", async () => {
        const chart = ooxml({"word/document.xml": "<w:document/>", "word/charts/chart1.xml": "<c:chartSpace/>",
            "word/embeddings/Microsoft_Excel_Worksheet.xlsx": ooxml({"xl/workbook.xml": "<workbook/>"})});
        const printer = ooxml({"xl/workbook.xml": "<workbook/>", "xl/printerSettings/printerSettings1.bin": Buffer.alloc(64, 1)});
        expect((await upload([{data: chart, name: "report.docx", type: DOCX}])).status).toBe(200);
        expect((await upload([{data: printer, name: "budget.xlsx", type: XLSX}])).status).toBe(200);
    });

    it("refuses current Office files with macros, a packaged object or a remote template", async () => {
        const macros = ooxml({"word/document.xml": "<w:document/>", "word/vbaProject.bin": Buffer.alloc(16)});
        const packaged = ooxml({"word/document.xml": "<w:document/>", "word/embeddings/oleObject1.bin": oleFile([{name: "\u0001Ole10Native", type: 2}])});
        const remoteTemplate = ooxml({"word/document.xml": "<w:document/>", "word/_rels/settings.xml.rels":
            '<Relationships><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="https://example.com/t.dotm" TargetMode="External"/></Relationships>'});
        for (const data of [macros, packaged, remoteTemplate]) {
            expect((await upload([{data, name: "file.docx", type: DOCX}])).body.error_code).toBe("office_document_validation_failed");
        }
    });

    it("accepts a PDF that declares encryption and stores it as uploaded", async () => {
        const pdf = await PDFDocument.create();
        pdf.addPage([200, 200]);
        pdf.context.trailerInfo.Encrypt = pdf.context.obj({Filter: "Standard", V: 1, R: 2, P: -4});
        const bytes = Buffer.from(await pdf.save({useObjectStreams: false}));
        const res = await upload([{data: bytes, name: "statement.pdf", type: "application/pdf"}]);
        expect(res.status).toBe(200);
        expect((await storedFile(res.body.files[0])).bytes.equals(bytes)).toBe(true);
    });

    it("turns photos upright before re-encoding drops their orientation", async () => {
        const sideways = await sharp({create: {width: 40, height: 20, channels: 3, background: "#0a0"}}).jpeg().withMetadata({orientation: 6}).toBuffer();
        const res = await upload([{data: sideways, name: "photo.jpg", type: "image/jpeg"}]);
        const {media} = await storedFile(res.body.files[0]);
        expect(media.resolution).toMatchObject({width: 20, height: 40});
    });

    it("stores an SVG as a sharp PNG, named and typed as one", async () => {
        const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="10" fill="red"/></svg>');
        const res = await upload([{data: svg, name: "logo.svg", type: "image/svg+xml"}]);
        const {media, bytes} = await storedFile(res.body.files[0]);
        expect(media).toMatchObject({originalName: "logo.png", mimeType: "image/png", extension: ".png"});
        expect(bytes.subarray(0, 4).toString("hex")).toBe("89504e47");
        expect(media.resolution.width).toBe(1024);
    });

    it("keeps a GIF animated", async () => {
        const frame = (color: string) => sharp({create: {width: 8, height: 8, channels: 3, background: color}}).png().toBuffer();
        const gif = await sharp([await frame("#f00"), await frame("#00f")], {join: {animated: true}}).gif().toBuffer();
        const res = await upload([{data: gif, name: "spinner.gif", type: "image/gif"}]);
        const {media, bytes} = await storedFile(res.body.files[0]);
        expect(media.mimeType).toBe("image/gif");
        expect((await sharp(bytes).metadata()).pages).toBe(2);
    });
});

describe("cleaning", () => {
    it("strips scripts from a PDF's pages and links but keeps web links", async () => {
        const pdf = await PDFDocument.create();
        const page = pdf.addPage([200, 200]);
        const script = () => pdf.context.obj({Type: "Action", S: "JavaScript", JS: PDFString.of("app.alert(1)")});
        page.node.set(PDFName.of("AA"), pdf.context.obj({O: script()}));
        const annotation = (action: ReturnType<typeof script>, subtype = "Link") =>
            pdf.context.register(pdf.context.obj({Type: "Annot", Subtype: subtype, Rect: [0, 0, 10, 10], A: action}));
        const web = pdf.context.obj({S: "URI", URI: PDFString.of("https://example.com"), Next: script()});
        page.node.set(PDFName.of("Annots"), pdf.context.obj([annotation(script()), annotation(web), annotation(script(), "FileAttachment")]));
        pdf.catalog.set(PDFName.of("OpenAction"), script());

        const res = await upload([{data: Buffer.from(await pdf.save()), name: "brochure.pdf", type: "application/pdf"}]);
        const cleaned = await PDFDocument.load((await storedFile(res.body.files[0])).bytes);
        const node = cleaned.getPages()[0].node;
        const annotations = node.lookup(PDFName.of("Annots"), PDFArray);
        const actions = Array.from({length: annotations.size()}, (_, index) =>
            cleaned.context.lookup(annotations.get(index), PDFDict).lookupMaybe(PDFName.of("A"), PDFDict));

        expect(cleaned.catalog.get(PDFName.of("OpenAction"))).toBeUndefined();
        expect(node.get(PDFName.of("AA"))).toBeUndefined();
        expect(actions).toHaveLength(2);
        expect(actions[0]).toBeUndefined();
        expect(String(actions[1]?.get(PDFName.of("S")))).toBe("/URI");
        expect(actions[1]?.get(PDFName.of("Next"))).toBeUndefined();
    });

    it("records a file the mock scanner let through as not scanned", async () => {
        const res = await upload([{data: Buffer.from("hello"), name: "notes.txt", type: "text/plain"}]);
        const {media} = await storedFile(res.body.files[0]);
        expect(media.metadata).toMatchObject({safeCheckedFlag: false, scannerResult: "Not scanned: no malware scanner is configured"});
    });
});
