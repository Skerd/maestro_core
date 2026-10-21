import {afterAll, beforeAll, describe, expect, it, vi} from "vitest";
import {MongoMemoryReplSet} from "mongodb-memory-server";
import mongoose from "mongoose";
import {ObjectId} from "mongodb";
import express from "express";
import request from "supertest";
import Media from "@coreModule/database/schemas/media/media";
import {createGridFSStorage} from "@coreModule/utilities/gridfs/gridfsStorage";
import {parseByteRange, serveMedia} from "@coreModule/utilities/media/serveMedia";

const logger: any = {err: vi.fn(), warn: vi.fn(), debug: vi.fn(), start: vi.fn(), finish: vi.fn(), info: vi.fn()};
const body = Buffer.from(Array.from({length: 1000}, (_, i) => i % 256));
let replSet: MongoMemoryReplSet;
let mediaId: string;

const app = express();
app.get("/media/:id", (req, res) => {
    serveMedia({mediaId: req.params.id, req, res, logger, languageCode: "en-US"}).catch(() => res.status(500).end());
});

beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({replSet: {count: 1}});
    await mongoose.connect(replSet.getUri());
    const fileId = await createGridFSStorage("en-US", "media", logger).uploadFile(body, "clip.mp4", {});
    const media = await Media.create({
        type: "video",
        fileName: "clip.mp4",
        originalName: "clip.mp4",
        fileId,
        mimeType: "video/mp4",
        extension: "mp4",
        fileSize: body.length,
        sizeInBytes: body.length,
        metadata: {size: body.length, extension: "mp4", mime: "video/mp4", safeCheckedFlag: true},
        company: new ObjectId(),
        createdBy: new ObjectId(),
    });
    mediaId = media._id.toString();
}, 120000);

afterAll(async () => {
    await mongoose.disconnect();
    await replSet.stop();
});

describe("parseByteRange", () => {
    it("reads explicit, open-ended and suffix ranges", () => {
        expect(parseByteRange("bytes=0-99", 1000)).toEqual({start: 0, end: 99});
        expect(parseByteRange("bytes=900-", 1000)).toEqual({start: 900, end: 999});
        expect(parseByteRange("bytes=-100", 1000)).toEqual({start: 900, end: 999});
        expect(parseByteRange("bytes=-5000", 1000)).toEqual({start: 0, end: 999});
    });

    it("clamps an end past the file to the last byte", () => {
        expect(parseByteRange("bytes=500-5000", 1000)).toEqual({start: 500, end: 999});
    });

    it("rejects a start past the end and an empty suffix", () => {
        expect(parseByteRange("bytes=1000-", 1000)).toBe("unsatisfiable");
        expect(parseByteRange("bytes=-0", 1000)).toBe("unsatisfiable");
    });

    it("ignores absent, malformed, reversed and multi-range headers", () => {
        expect(parseByteRange(undefined, 1000)).toBeUndefined();
        expect(parseByteRange("bytes=-", 1000)).toBeUndefined();
        expect(parseByteRange("items=0-1", 1000)).toBeUndefined();
        expect(parseByteRange("bytes=50-10", 1000)).toBeUndefined();
        expect(parseByteRange("bytes=0-1,5-6", 1000)).toBeUndefined();
    });
});

describe("serveMedia byte ranges", () => {
    it("sends the whole file with Accept-Ranges when no range is asked", async () => {
        const res = await request(app).get(`/media/${mediaId}`).responseType("blob");
        expect(res.status).toBe(200);
        expect(res.headers["accept-ranges"]).toBe("bytes");
        expect(res.headers["content-length"]).toBe("1000");
        expect(Buffer.compare(res.body, body)).toBe(0);
    });

    it("sends 206 with the requested slice", async () => {
        const res = await request(app).get(`/media/${mediaId}`).set("Range", "bytes=100-199").responseType("blob");
        expect(res.status).toBe(206);
        expect(res.headers["content-range"]).toBe("bytes 100-199/1000");
        expect(res.headers["content-length"]).toBe("100");
        expect(Buffer.compare(res.body, body.subarray(100, 200))).toBe(0);
    });

    it("sends the tail for a suffix range", async () => {
        const res = await request(app).get(`/media/${mediaId}`).set("Range", "bytes=-10").responseType("blob");
        expect(res.status).toBe(206);
        expect(res.headers["content-range"]).toBe("bytes 990-999/1000");
        expect(Buffer.compare(res.body, body.subarray(990))).toBe(0);
    });

    it("answers 416 for a range past the end", async () => {
        const res = await request(app).get(`/media/${mediaId}`).set("Range", "bytes=2000-");
        expect(res.status).toBe(416);
        expect(res.headers["content-range"]).toBe("bytes */1000");
    });
});
