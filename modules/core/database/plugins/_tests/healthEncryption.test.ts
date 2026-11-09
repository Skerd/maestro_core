import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";
import mongoose, {Schema} from "mongoose";
import {ObjectId} from "mongodb";
import express, {NextFunction, Request, Response} from "express";
import request from "supertest";
import sharp from "sharp";

vi.mock("@coreModule/utilities/middlewares/authMW", async () =>
    (await import("@coreModule/_tests/httpHarness")).authMWStub);
vi.mock("@coreModule/utilities/middlewares/rateLimiter", () => ({
    rateLimiter: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import {appFor, callerHeader, type TestCaller} from "@coreModule/_tests/httpHarness";
import ownershipPlugin from "@coreModule/database/plugins/ownershipPlugin";
import auditPlugin from "@coreModule/database/plugins/auditPlugin";
import {decryptHealthDiff, healthFieldPaths} from "@coreModule/database/plugins/healthEncryption";
import AuditLog from "@coreModule/database/schemas/auditLog/auditLog";
import CompanyDataKey from "@coreModule/database/schemas/companyDataKey/companyDataKey";
import Media from "@coreModule/database/schemas/media/media";
import * as mediaRoute from "@coreModule/api/auxiliary/private/media";
import authMW from "@coreModule/utilities/middlewares/authMW";
import {mediaUploadMW} from "@coreModule/utilities/middlewares/mediaUploadMW";
import {getGridFSStorage} from "@coreModule/utilities/gridfs/gridfsStorage";
import {asCrossTenant, withTenant} from "@coreModule/utilities/endpoints/tenantScope";
import {validateHealthDataKeys} from "@coreModule/environment/validator";
import {
    encryptHealthValue,
    isHealthCiphertext,
    openMediaFile,
    rewrapCompanyDataKeys,
    sealMediaFile,
} from "@coreModule/utilities/security/healthDataCrypto";

// A core fixture (CORE-07): a record with a health field and a reference to health files.
const chartSchema = new Schema({
    title: String,
    history: {type: {notes: String, takenAt: Date, by: Schema.Types.ObjectId}, sensitivity: "health"},
    scans: {type: [{type: Schema.Types.ObjectId, ref: "Media"}], default: [], sensitivity: "health"},
});
ownershipPlugin(chartSchema);
auditPlugin(chartSchema);
const Chart = mongoose.model("HealthEncryptionChart", chartSchema);

const SECRET = "allergic to penicillin";
const companyA = new ObjectId();
const companyB = new ObjectId();
const asA = <T>(fn: () => PromiseLike<T>) => withTenant(companyA, fn);
const asB = <T>(fn: () => PromiseLike<T>) => withTenant(companyB, fn);
const raw = (id: ObjectId) => Chart.collection.findOne({_id: id});
const history = () => ({notes: SECRET, takenAt: new Date("2026-11-01T09:00:00Z"), by: new ObjectId()});

beforeAll(async () => {
    await connectTestDatabase();
}, 120000);

afterAll(async () => {
    await disconnectTestDatabase();
});

beforeEach(async () => {
    await Promise.all([Chart, AuditLog, Media].map((model) => model.collection.deleteMany({})));
});

describe("health fields at rest (D102)", () => {
    it("seals only data fields: a reference keeps its ids, its files are sealed at the media layer", () => {
        expect(healthFieldPaths(chartSchema)).toEqual(["history"]);
    });

    it("stores ciphertext and gives the plaintext back, with its dates and ids, hydrated and lean", () => asA(async () => {
        const value = history();
        const scan = new ObjectId();
        const chart = await Chart.create({company: companyA, title: "A", history: value, scans: [scan]});
        // The document in memory keeps the plaintext after the write.
        expect(chart.history?.notes).toBe(SECRET);

        const stored = await raw(chart._id);
        expect(isHealthCiphertext(stored?.history)).toBe(true);
        expect(JSON.stringify(stored)).not.toContain("penicillin");
        expect(stored?.scans).toEqual([scan]);

        const loaded = await Chart.findById(chart._id);
        expect(loaded?.history?.notes).toBe(SECRET);
        expect(loaded?.history?.takenAt).toEqual(value.takenAt);
        expect(String(loaded?.history?.by)).toBe(String(value.by));
        expect(loaded?.isModified()).toBe(false);

        const lean = await Chart.findOne({_id: chart._id}).lean();
        expect(lean?.history?.takenAt).toBeInstanceOf(Date);
        expect(lean?.history?.notes).toBe(SECRET);
    }));

    it("loads the whole field when a projection asks for part of it", () => asA(async () => {
        const chart = await Chart.create({company: companyA, title: "A", history: history()});
        const part = await Chart.findById(chart._id).select("title history.notes").lean();
        expect(part?.history?.notes).toBe(SECRET);
        const without = await Chart.findById(chart._id).select("title").lean();
        expect(without?.history).toBeUndefined();
    }));

    it("seals again when part of the field changes, and keeps it unchanged when another field does", () => asA(async () => {
        const chart = await Chart.create({company: companyA, title: "A", history: history()});
        const first = (await raw(chart._id))?.history;

        const loaded = await Chart.findById(chart._id);
        loaded!.set("history.notes", "no allergies");
        await loaded!.save();
        const second = (await raw(chart._id))?.history;
        expect(isHealthCiphertext(second)).toBe(true);
        expect(second).not.toBe(first);
        expect((await Chart.findById(chart._id))?.history?.notes).toBe("no allergies");

        const again = await Chart.findById(chart._id);
        again!.title = "B";
        await again!.save();
        expect((await raw(chart._id))?.history).toBe(second);
    }));

    it("reads a record stored before encryption, and seals it on its next save", () => asA(async () => {
        const _id = new ObjectId();
        await Chart.collection.insertOne({_id, company: companyA, title: "old", history: {notes: SECRET}});
        const legacy = await Chart.findById(_id);
        expect(legacy?.history?.notes).toBe(SECRET);

        legacy!.title = "touched";
        await legacy!.save();
        const stored = await raw(_id);
        expect(isHealthCiphertext(stored?.history)).toBe(true);
        expect(JSON.stringify(stored)).not.toContain("penicillin");
        expect((await Chart.findById(_id))?.history?.notes).toBe(SECRET);
    }));

    it("refuses a tampered ciphertext with health_data_unreadable, never an empty value", () => asA(async () => {
        const chart = await Chart.create({company: companyA, title: "A", history: history()});
        const sealed = String((await raw(chart._id))?.history);
        // A character inside the ciphertext (the last one may carry unused bits).
        const at = sealed.length - 10;
        await Chart.collection.updateOne({_id: chart._id}, {$set: {history: `${sealed.slice(0, at)}${sealed[at] === "A" ? "B" : "A"}${sealed.slice(at + 1)}`}});

        await expect(Chart.findById(chart._id)).rejects.toMatchObject({error_code: "health_data_unreadable", status: 409});
        await expect(Chart.findById(chart._id).lean()).rejects.toMatchObject({error_code: "health_data_unreadable"});
    }));

    it("does not open a ciphertext moved to another record or to another company's record", async () => {
        const source = await asA(() => Chart.create({company: companyA, title: "A", history: history()}));
        const sameCompany = await asA(() => Chart.create({company: companyA, title: "B"}));
        const otherCompany = await asB(() => Chart.create({company: companyB, title: "C", history: {notes: "other"}}));
        const sealed = (await raw(source._id))?.history;

        await Chart.collection.updateOne({_id: sameCompany._id}, {$set: {history: sealed}});
        await expect(asA(() => Chart.findById(sameCompany._id))).rejects.toMatchObject({error_code: "health_data_unreadable"});

        await Chart.collection.updateOne({_id: otherCompany._id}, {$set: {history: sealed}});
        await expect(asB(() => Chart.findById(otherCompany._id))).rejects.toMatchObject({error_code: "health_data_unreadable"});

        // Each company has its own key, and only the wrapped form is stored.
        const keys = await asCrossTenant("test lists every company's keys", () => CompanyDataKey.find({}).lean());
        expect(keys.map((key) => String(key.company)).sort()).toEqual([String(companyA), String(companyB)].sort());
        expect(keys.every((key) => key.version === 1 && key.wrappedKey.split(".").length === 3)).toBe(true);
    });

    it("keeps health values in audit diffs sealed, and opens them for an allowed reader", () => asA(async () => {
        const chart = await Chart.create({company: companyA, title: "A", history: history()});
        const loaded = await Chart.findById(chart._id);
        loaded!.set("history.notes", "no allergies");
        await loaded!.save();

        const entries = await AuditLog.find({documentId: chart._id}).lean();
        expect(entries.map((entry) => entry.action).sort()).toEqual(["CREATE", "UPDATE"]);
        expect(JSON.stringify(entries)).not.toContain("allerg");
        const update = entries.find((entry) => entry.action === "UPDATE")!;
        expect(isHealthCiphertext(update.diff.history?.from)).toBe(true);

        const opened = await decryptHealthDiff(chartSchema, update.diff, {collection: Chart.collection.name, documentId: chart._id});
        expect(opened.history).toMatchObject({from: {notes: SECRET}, to: {notes: "no allergies"}});
    }));

    it("refuses writes that would store a value without sealing it, and lets erasure remove it", () => asA(async () => {
        const chart = await Chart.create({company: companyA, title: "A", history: history()});
        await expect(Chart.updateOne({_id: chart._id}, {$set: {history: {notes: "plain"}}})).rejects.toThrow(/health data/);
        await expect(Chart.updateOne({_id: chart._id}, {$set: {"history.notes": "plain"}})).rejects.toThrow(/health data/);
        await expect(Chart.insertMany([{company: companyA, history: {notes: "plain"}}])).rejects.toThrow(/health data/);

        await Chart.updateOne({_id: chart._id}, {$unset: {history: ""}});
        expect((await raw(chart._id))?.history).toBeUndefined();
    }));

    it("rewraps the data keys under a new master key; the data still opens", () => asA(async () => {
        const chart = await Chart.create({company: companyA, title: "A", history: history()});
        const current = process.env.HEALTH_DATA_MASTER_KEY!;
        const next = Buffer.alloc(32, 7).toString("base64");
        const before = await asCrossTenant("test", () => CompanyDataKey.findOne({company: companyA}).lean());
        const keyCount = await asCrossTenant("test", () => CompanyDataKey.countDocuments({}));

        expect(await asCrossTenant("test rotates every key", () => rewrapCompanyDataKeys({current: next, previous: current}))).toBe(keyCount);
        const rewrapped = await asCrossTenant("test", () => CompanyDataKey.findOne({company: companyA}).lean());
        expect(rewrapped?.wrappedKey).not.toBe(before?.wrappedKey);
        expect(await asCrossTenant("test", () => rewrapCompanyDataKeys({current: next, previous: current}))).toBe(0);
        // Back under the configured key, opened with the previous one: the key itself never changed.
        expect(await asCrossTenant("test", () => rewrapCompanyDataKeys({current, previous: next}))).toBe(keyCount);
        expect((await Chart.findById(chart._id))?.history?.notes).toBe(SECRET);
    }));
});

describe("health files at rest (D102)", () => {
    const caller: TestCaller = {userId: new ObjectId().toString(), companyId: companyA.toString()};
    const stranger: TestCaller = {userId: new ObjectId().toString(), companyId: companyB.toString()};
    const uploads = express.Router();
    uploads.post(
        "/",
        authMW("private"),
        (req: Request, _res: Response, next: NextFunction) => {
            req.body.userInfo = {_id: new ObjectId(caller.userId)};
            req.body.user = {company: {_id: companyA}};
            next();
        },
        mediaUploadMW({fields: {files: 2}, healthData: true, enableSecurityScan: false, sanitizeImages: false}),
        (req: Request, res: Response) => res.json({files: req.body.files}),
    );
    const app = appFor([{basePath: "/test/upload", router: uploads}, {...mediaRoute, basePath: "/api/auxiliary/media"}]);

    it("stores an uploaded X-ray encrypted and gives the original bytes to an allowed reader only", async () => {
        const xray = await sharp({create: {width: 8, height: 8, channels: 3, background: "#808080"}}).png().toBuffer();
        const uploaded = await request(app).post("/test/upload").set(callerHeader(caller)).attach("files", xray, {filename: "opg.png", contentType: "image/png"});
        expect(uploaded.status).toBe(200);
        const [mediaId] = uploaded.body.files as string[];

        const media = await asA(() => Media.findById(mediaId).lean());
        expect(media?.encrypted).toBe(true);
        const stored = await getGridFSStorage("en-US").getFileBuffer(String(media?.fileId));
        expect(stored.equals(xray)).toBe(false);
        expect(stored.includes(xray.subarray(16, 48))).toBe(false);

        const downloaded = await request(app).get(`/api/auxiliary/media/${mediaId}`).set(callerHeader(caller)).responseType("blob");
        expect(downloaded.status).toBe(200);
        expect(downloaded.headers["cache-control"]).toBe("no-store");
        expect(Buffer.compare(downloaded.body, xray)).toBe(0);

        // Media access is unchanged: another company's request does not even find the file (tenant scope).
        const denied = await request(app).get(`/api/auxiliary/media/${mediaId}`).set(callerHeader(stranger));
        expect(denied.body.error_code).toBe("media_not_found");
    });

    it("opens a file only for the record it was sealed for", async () => {
        const mediaId = new ObjectId();
        const sealed = await sealMediaFile(Buffer.from("x-ray bytes"), companyA, mediaId);
        expect((await openMediaFile(sealed, companyA, mediaId)).toString()).toBe("x-ray bytes");
        await expect(openMediaFile(sealed, companyA, new ObjectId())).rejects.toMatchObject({error_code: "health_data_unreadable"});
        await expect(openMediaFile(sealed, companyB, mediaId)).rejects.toMatchObject({error_code: "health_data_unreadable"});
    });
});

describe("master key configuration (D102)", () => {
    it("accepts 32 random bytes in base64 and rejects anything else", () => {
        const key = Buffer.alloc(32, 1).toString("base64");
        expect(validateHealthDataKeys({HEALTH_DATA_MASTER_KEY: key, HEALTH_DATA_MASTER_KEY_PREVIOUS: key})).toEqual([]);
        expect(validateHealthDataKeys({})).toEqual([]);
        expect(validateHealthDataKeys({HEALTH_DATA_MASTER_KEY: "too-short"}).map((error) => error.key)).toEqual(["HEALTH_DATA_MASTER_KEY"]);
        expect(validateHealthDataKeys({HEALTH_DATA_MASTER_KEY_PREVIOUS: Buffer.alloc(16).toString("base64")}).map((error) => error.key)).toEqual(["HEALTH_DATA_MASTER_KEY_PREVIOUS"]);
    });

    it("binds a value to its record: the same plaintext seals differently each time", () => asA(async () => {
        const binding = {company: companyA, collection: "charts", documentId: new ObjectId(), path: "history"};
        expect(await encryptHealthValue({notes: SECRET}, binding)).not.toBe(await encryptHealthValue({notes: SECRET}, binding));
    }));
});
