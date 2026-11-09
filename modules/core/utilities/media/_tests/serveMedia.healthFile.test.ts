import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from "vitest";
import crypto from "crypto";
import {Readable} from "stream";
import http from "http";
import {AddressInfo} from "net";
import express from "express";
import mongoose from "mongoose";
import {ObjectId} from "mongodb";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";
import {loopbackServer} from "@coreModule/_tests/httpHarness";
import Media from "@coreModule/database/schemas/media/media";
import CompanyDataKey from "@coreModule/database/schemas/companyDataKey/companyDataKey";
import {createGridFSStorage, GridFSStorage} from "@coreModule/utilities/gridfs/gridfsStorage";
import {readMediaBytes, readMediaStream, serveMedia} from "@coreModule/utilities/media/serveMedia";
import {withTenant} from "@coreModule/utilities/endpoints/tenantScope";
import {
    HEALTH_FILE_HEADER_BYTES,
    openMediaFile,
    openMediaFileChunks,
    readSealedFileHeader,
    sealedSpanOf,
    sealMediaFile,
    sealMediaFileStream,
} from "@coreModule/utilities/security/healthDataCrypto";

/*
 * Health files stream (TD-B101, D102): format HFE2 seals the file in chunks, each verified before it is sent, so a
 * download never holds the whole file and byte ranges work. Files sealed before (HFE1) still download whole.
 */

const logger: any = {err: vi.fn(), warn: vi.fn(), debug: vi.fn(), start: vi.fn(), finish: vi.fn(), info: vi.fn()};
const company = new ObjectId();
/** The HFE2 chunk size: 64 KiB of plaintext per sealed chunk. */
const CHUNK = 64 * 1024;
/** Magic, key version, company, chunk size, plaintext size, base nonce. */
const HEADER = 4 + 4 + 12 + 4 + 8 + 12;
const TAG = 16;
const SEALED_CHUNK = CHUNK + TAG;

/** Rejections serveMedia let out after the headers were sent: must stay 0 (it ends the response itself). */
let rejectedAfterHeaders = 0;
const app = express();
app.get("/media/:id", (req, res) => {
    withTenant(company, () => serveMedia({mediaId: req.params.id, req, res, logger, languageCode: "en-US", cacheControl: "private"}))
        .catch((error: {error_code?: string}) => {
            if (res.headersSent) {
                rejectedAfterHeaders += 1;
                res.destroy();
                return;
            }
            res.status(error.error_code === "health_data_unreadable" ? 409 : 500).json({error_code: error.error_code});
        });
});
const server = loopbackServer(app);

const gridfs = () => createGridFSStorage("en-US", "media", logger);
const random = (length: number) => crypto.randomBytes(length);

/** A health file stored as given (sealed, tampered or legacy) for the Media record `mediaId`. */
async function storeHealthFile(mediaId: ObjectId, stored: Buffer, plainLength: number): Promise<string> {
    const fileId = await gridfs().uploadFile(stored, "opg.png", {});
    await withTenant(company, () => Media.create({
        _id: mediaId,
        encrypted: true,
        type: "image",
        fileName: "opg.png",
        originalName: "opg.png",
        fileId,
        mimeType: "image/png",
        extension: "png",
        fileSize: plainLength,
        sizeInBytes: plainLength,
        metadata: {size: plainLength, extension: "png", mime: "image/png", safeCheckedFlag: true},
        company,
        createdBy: new ObjectId(),
    }));
    return mediaId.toString();
}

async function sealedFile(plain: Buffer, mediaId = new ObjectId()): Promise<{mediaId: ObjectId; sealed: Buffer}> {
    return {mediaId, sealed: await sealMediaFile(plain, company, mediaId)};
}

type Received = {status: number; headers: http.IncomingHttpHeaders; body: Buffer; complete: boolean};

/** A raw GET that also reports a response cut short (the connection closed before Content-Length bytes). */
function get(mediaId: string, headers: Record<string, string> = {}): Promise<Received> {
    const {port} = server.address() as AddressInfo;
    return new Promise((resolve, reject) => {
        http.get({host: "127.0.0.1", port, path: `/media/${mediaId}`, headers}, (res) => {
            const parts: Buffer[] = [];
            res.on("data", (part: Buffer) => parts.push(part));
            res.on("error", () => undefined);
            res.on("close", () => resolve({status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts), complete: res.complete}));
        }).on("error", reject);
    });
}

beforeAll(async () => {
    await connectTestDatabase();
}, 120000);

afterAll(async () => {
    await disconnectTestDatabase();
});

afterEach(() => {
    vi.restoreAllMocks();
    expect(rejectedAfterHeaders).toBe(0);
});

describe("HFE2 health files (TD-B101)", () => {
    it("seals in authenticated chunks under a versioned header", async () => {
        const plain = random(Math.floor(3.5 * CHUNK));
        const {sealed} = await sealedFile(plain);
        expect(sealed.subarray(0, 4).toString()).toBe("HFE2");
        expect(sealed.subarray(8, 20).toString("hex")).toBe(company.toHexString());
        expect(sealed.readUInt32BE(20)).toBe(CHUNK);
        expect(Number(sealed.readBigUInt64BE(24))).toBe(plain.length);
        // 4 chunks, each with its own tag.
        expect(sealed.length).toBe(HEADER + plain.length + 4 * TAG);
        expect(sealed.includes(plain.subarray(1000, 1032))).toBe(false);
    });

    it("round-trips a small file over HTTP, uncached", async () => {
        const plain = Buffer.from("x-ray bytes");
        const {mediaId, sealed} = await sealedFile(plain);
        const id = await storeHealthFile(mediaId, sealed, plain.length);
        const res = await get(id);
        expect(res.status).toBe(200);
        expect(res.complete).toBe(true);
        expect(res.headers["cache-control"]).toBe("no-store");
        expect(res.headers["accept-ranges"]).toBe("bytes");
        expect(res.headers["content-length"]).toBe(String(plain.length));
        expect(res.body.equals(plain)).toBe(true);
        expect((await openMediaFile(sealed, company, mediaId)).equals(plain)).toBe(true);
    });

    it("round-trips an empty file", async () => {
        const {mediaId, sealed} = await sealedFile(Buffer.alloc(0));
        expect(sealed.length).toBe(HEADER + TAG);
        const res = await get(await storeHealthFile(mediaId, sealed, 0));
        expect(res.status).toBe(200);
        expect(res.body.length).toBe(0);
        expect((await openMediaFile(sealed, company, mediaId)).length).toBe(0);
    });

    it("streams a multi-chunk file without ever loading it whole", async () => {
        const plain = random(Math.floor(3.5 * CHUNK));
        const {mediaId, sealed} = await sealedFile(plain);
        const id = await storeHealthFile(mediaId, sealed, plain.length);
        const whole = vi.spyOn(GridFSStorage.prototype, "getFileBuffer");
        const res = await get(id);
        expect(res.status).toBe(200);
        expect(res.complete).toBe(true);
        expect(res.headers["content-length"]).toBe(String(plain.length));
        expect(res.body.equals(plain)).toBe(true);
        expect(whole).not.toHaveBeenCalled();
        const media = await withTenant(company, () => Media.findById(mediaId));
        expect((await readMediaBytes(media!, "en-US")).equals(plain)).toBe(true);
    });

    it("answers a range by opening only the chunks it covers, with the exact bytes", async () => {
        const plain = random(Math.floor(3.5 * CHUNK));
        const {mediaId, sealed} = await sealedFile(plain);
        const id = await storeHealthFile(mediaId, sealed, plain.length);
        const reads = vi.spyOn(GridFSStorage.prototype, "downloadFile");
        // Crosses from chunk 1 into chunk 2.
        const start = CHUNK + 1000;
        const end = 2 * CHUNK + 999;
        const res = await get(id, {Range: `bytes=${start}-${end}`});
        expect(res.status).toBe(206);
        expect(res.headers["content-range"]).toBe(`bytes ${start}-${end}/${plain.length}`);
        expect(res.headers["content-length"]).toBe(String(end - start + 1));
        expect(res.headers["cache-control"]).toBe("no-store");
        expect(res.body.equals(plain.subarray(start, end + 1))).toBe(true);
        // The header, then chunks 1 and 2 only.
        const ranges = reads.mock.calls.map(([, range]) => range);
        expect(ranges).toContainEqual({start: HEADER + SEALED_CHUNK, end: HEADER + 3 * SEALED_CHUNK - 1});
        expect(ranges.every((range) => range && range.end - range.start + 1 <= 2 * SEALED_CHUNK)).toBe(true);

        const tail = await get(id, {Range: "bytes=-10"});
        expect(tail.status).toBe(206);
        expect(tail.body.equals(plain.subarray(plain.length - 10))).toBe(true);
        const past = await get(id, {Range: `bytes=${plain.length}-`});
        expect(past.status).toBe(416);
        expect(past.headers["content-range"]).toBe(`bytes */${plain.length}`);
    });

    it("refuses a tampered first chunk before sending anything", async () => {
        const plain = random(Math.floor(3.5 * CHUNK));
        const {mediaId, sealed} = await sealedFile(plain);
        sealed[HEADER + 10] ^= 1;
        const res = await get(await storeHealthFile(mediaId, sealed, plain.length));
        expect(res.status).toBe(409);
        expect(JSON.parse(res.body.toString()).error_code).toBe("health_data_unreadable");
        await expect(openMediaFile(sealed, company, mediaId)).rejects.toMatchObject({error_code: "health_data_unreadable"});
    });

    it("cuts the connection at a tampered later chunk, after the verified bytes only", async () => {
        const plain = random(Math.floor(3.5 * CHUNK));
        const {mediaId, sealed} = await sealedFile(plain);
        sealed[HEADER + 2 * SEALED_CHUNK + 10] ^= 1;
        const id = await storeHealthFile(mediaId, sealed, plain.length);
        const res = await get(id);
        // Headers were already out: the client gets an incomplete download, never the bad chunk.
        expect(res.status).toBe(200);
        expect(res.complete).toBe(false);
        expect(res.body.length).toBeLessThanOrEqual(2 * CHUNK);
        expect(res.body.equals(plain.subarray(0, res.body.length))).toBe(true);
        // A range that starts in the bad chunk is refused outright.
        const ranged = await get(id, {Range: `bytes=${2 * CHUNK}-${2 * CHUNK + 99}`});
        expect(ranged.status).toBe(409);
        // A range clear of it still opens.
        const clean = await get(id, {Range: "bytes=0-99"});
        expect(clean.body.equals(plain.subarray(0, 100))).toBe(true);
    });

    it("refuses a truncated file before sending anything", async () => {
        const plain = random(Math.floor(3.5 * CHUNK));
        const {mediaId, sealed} = await sealedFile(plain);
        const cut = await get(await storeHealthFile(mediaId, sealed.subarray(0, sealed.length - 100), plain.length));
        expect(cut.status).toBe(409);

        // The last chunk dropped whole, with the header's size rewritten to match: the header is bound to every chunk.
        const second = await sealedFile(plain);
        const shortened = Buffer.from(second.sealed.subarray(0, HEADER + 3 * SEALED_CHUNK));
        shortened.writeBigUInt64BE(BigInt(3 * CHUNK), 24);
        const dropped = await get(await storeHealthFile(second.mediaId, shortened, 3 * CHUNK));
        expect(dropped.status).toBe(409);
        await expect(openMediaFile(shortened, company, second.mediaId)).rejects.toMatchObject({error_code: "health_data_unreadable"});
    });

    it("refuses reordered chunks and chunks spliced from another file", async () => {
        const plain = random(Math.floor(3.5 * CHUNK));
        const {mediaId, sealed} = await sealedFile(plain);
        const chunk = (bytes: Buffer, index: number) => bytes.subarray(HEADER + index * SEALED_CHUNK, HEADER + (index + 1) * SEALED_CHUNK);
        const swapped = Buffer.concat([sealed.subarray(0, HEADER), chunk(sealed, 0), chunk(sealed, 2), chunk(sealed, 1), sealed.subarray(HEADER + 3 * SEALED_CHUNK)]);
        const id = await storeHealthFile(mediaId, swapped, plain.length);
        const res = await get(id);
        expect(res.complete).toBe(false);
        expect(res.body.equals(plain.subarray(0, res.body.length))).toBe(true);
        expect(res.body.length).toBeLessThanOrEqual(CHUNK);
        expect((await get(id, {Range: `bytes=${CHUNK}-${CHUNK + 9}`})).status).toBe(409);
        await expect(openMediaFile(swapped, company, mediaId)).rejects.toMatchObject({error_code: "health_data_unreadable"});

        // Same company key, same position, another file.
        const other = await sealMediaFile(random(plain.length), company, mediaId);
        const spliced = Buffer.concat([sealed.subarray(0, HEADER + SEALED_CHUNK), chunk(other, 1), sealed.subarray(HEADER + 2 * SEALED_CHUNK)]);
        await expect(openMediaFile(spliced, company, mediaId)).rejects.toMatchObject({error_code: "health_data_unreadable"});
        // Another record or company.
        await expect(openMediaFile(sealed, company, new ObjectId())).rejects.toMatchObject({error_code: "health_data_unreadable"});
        await expect(openMediaFile(sealed, new ObjectId(), mediaId)).rejects.toMatchObject({error_code: "health_data_unreadable"});
    });
});

describe("HFE2 memory bounds (TD-B101)", () => {
    it("opens a chunk at a time, pulling from storage only as far as the chunk it yields", async () => {
        const plain = random(Math.floor(3.5 * CHUNK));
        const mediaId = new ObjectId();
        const sealed = Buffer.concat(await (await sealMediaFileStream(plain, company, mediaId)).toArray());
        const file = readSealedFileHeader(sealed.subarray(0, HEALTH_FILE_HEADER_BYTES), sealed.length, company, mediaId);
        if (file.format !== 2) throw new Error("expected HFE2");
        // Storage handing out 16 KiB pieces, counted as they are pulled.
        const PIECE = 16 * 1024;
        let pulled = 0;
        function* storage() {
            for (let at = HEADER; at < sealed.length; at += PIECE) {
                pulled += 1;
                yield sealed.subarray(at, at + PIECE);
            }
        }
        const totalPieces = Math.ceil((sealed.length - HEADER) / PIECE);
        const parts: Buffer[] = [];
        for await (const part of openMediaFileChunks(storage(), file, mediaId, sealedSpanOf(file))) {
            expect(part.length).toBeLessThanOrEqual(CHUNK);
            // At most the yielded chunks plus one piece of the next.
            expect(pulled * PIECE).toBeLessThan((parts.length + 1) * SEALED_CHUNK + PIECE);
            if (parts.length === 0) expect(pulled).toBeLessThan(totalPieces / 2);
            parts.push(part);
        }
        expect(parts.length).toBe(4);
        expect(Buffer.concat(parts).equals(plain)).toBe(true);
    });

    it("stops at a source that ends early, after the verified chunks only", async () => {
        const plain = random(Math.floor(2.5 * CHUNK));
        const mediaId = new ObjectId();
        const sealed = await sealMediaFile(plain, company, mediaId);
        const file = readSealedFileHeader(sealed.subarray(0, HEADER), sealed.length, company, mediaId);
        if (file.format !== 2) throw new Error("expected HFE2");
        const parts: Buffer[] = [];
        const opening = (async () => {
            for await (const part of openMediaFileChunks([sealed.subarray(HEADER, HEADER + SEALED_CHUNK + 100)], file, mediaId, sealedSpanOf(file))) parts.push(part);
        })();
        await expect(opening).rejects.toMatchObject({error_code: "health_data_unreadable"});
        expect(Buffer.concat(parts).equals(plain.subarray(0, CHUNK))).toBe(true);
    });
});

describe("HFE1 health files sealed before TD-B101", () => {
    /** The company's data key, unwrapped as the server does, to build a file in the old format. */
    async function companyDataKey(): Promise<{version: number; key: Buffer}> {
        await sealMediaFile(Buffer.from("make sure the key exists"), company, new ObjectId());
        const record = await withTenant(company, () => CompanyDataKey.findOne({company}).lean());
        const master = Buffer.from(String(process.env.HEALTH_DATA_MASTER_KEY), "base64");
        const [iv, tag, data] = record!.wrappedKey.split(".").map((part) => Buffer.from(part, "base64url"));
        const decipher = crypto.createDecipheriv("aes-256-gcm", master, iv!);
        decipher.setAAD(Buffer.from(`company-data-key|${company.toHexString()}|${record!.version}`));
        decipher.setAuthTag(tag!);
        return {version: record!.version, key: Buffer.concat([decipher.update(data!), decipher.final()])};
    }

    async function legacyFile(plain: Buffer, mediaId: ObjectId): Promise<Buffer> {
        const {version, key} = await companyDataKey();
        const iv = random(12);
        const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
        cipher.setAAD(Buffer.from(`${company.toHexString()}|media|${mediaId.toHexString()}|file`));
        const data = Buffer.concat([cipher.update(plain), cipher.final()]);
        const versionBytes = Buffer.alloc(4);
        versionBytes.writeUInt32BE(version);
        return Buffer.concat([Buffer.from("HFE1"), versionBytes, iv, cipher.getAuthTag(), data]);
    }

    it("still downloads whole, without ranges, and opens for server-side copies", async () => {
        const plain = random(100_000);
        const mediaId = new ObjectId();
        const stored = await legacyFile(plain, mediaId);
        const id = await storeHealthFile(mediaId, stored, plain.length);
        const res = await get(id, {Range: "bytes=10-19"});
        expect(res.status).toBe(200);
        expect(res.headers["accept-ranges"]).toBe("none");
        expect(res.headers["cache-control"]).toBe("no-store");
        expect(res.body.equals(plain)).toBe(true);
        const media = await withTenant(company, () => Media.findById(mediaId));
        expect((await readMediaBytes(media!, "en-US")).equals(plain)).toBe(true);

        const otherId = new ObjectId();
        const other = await legacyFile(plain, otherId);
        other[other.length - 1] ^= 1;
        const tampered = await get(await storeHealthFile(otherId, other, plain.length));
        expect(tampered.status).toBe(409);
    });

    it("opens whole for a streamed server-side copy (TD-B111)", async () => {
        const plain = random(100_000);
        const mediaId = new ObjectId();
        await storeHealthFile(mediaId, await legacyFile(plain, mediaId), plain.length);
        const media = await withTenant(company, () => Media.findById(mediaId));
        const source = await readMediaStream(media!, "en-US");
        expect(source.size).toBe(plain.length);
        expect(Buffer.concat(await Readable.from(source.chunks).toArray()).equals(plain)).toBe(true);
    });
});

describe("server-side copies of health files (TD-B111)", () => {
    const chunkCount = () => mongoose.connection.db!.collection("media.chunks").countDocuments();

    /** Copies `media`'s file the way a module copies it to another company: streamed, sealed again for the copy. */
    async function copyTo(target: ObjectId, mediaId: ObjectId): Promise<{copyId: ObjectId; fileId: ObjectId}> {
        const media = await withTenant(company, () => Media.findById(mediaId));
        const copyId = new ObjectId();
        const sealedCopy = await sealMediaFileStream(await readMediaStream(media!, "en-US"), target, copyId);
        return {copyId, fileId: await gridfs().uploadFile(sealedCopy, "copy.png", {})};
    }

    it("streams an HFE2 file into a copy sealed under the target company, never reading it whole", async () => {
        const plain = random(Math.floor(3.5 * CHUNK));
        const {mediaId, sealed} = await sealedFile(plain);
        await storeHealthFile(mediaId, sealed, plain.length);
        const target = new ObjectId();
        const whole = vi.spyOn(GridFSStorage.prototype, "getFileBuffer");
        const {copyId, fileId} = await copyTo(target, mediaId);
        expect(whole).not.toHaveBeenCalled();
        whole.mockRestore();

        const stored = await gridfs().getFileBuffer(fileId);
        expect(stored.subarray(0, 4).toString()).toBe("HFE2");
        expect(stored.subarray(8, 20).toString("hex")).toBe(target.toHexString());
        expect((await openMediaFile(stored, target, copyId)).equals(plain)).toBe(true);
        await expect(openMediaFile(stored, company, copyId)).rejects.toMatchObject({error_code: "health_data_unreadable"});
    });

    it("seals a source of uneven pieces exactly as one buffer would open", async () => {
        const plain = random(2 * CHUNK + 5000);
        const mediaId = new ObjectId();
        const pieces = [plain.subarray(0, 1000), plain.subarray(1000, CHUNK + 7), plain.subarray(CHUNK + 7, 2 * CHUNK), plain.subarray(2 * CHUNK)];
        const sealed = Buffer.concat(await (await sealMediaFileStream({size: plain.length, chunks: pieces}, company, mediaId)).toArray());
        expect(sealed.length).toBe(HEADER + plain.length + 3 * TAG);
        expect((await openMediaFile(sealed, company, mediaId)).equals(plain)).toBe(true);
        const empty = Buffer.concat(await (await sealMediaFileStream({size: 0, chunks: []}, company, mediaId)).toArray());
        expect((await openMediaFile(empty, company, mediaId)).length).toBe(0);
    });

    it("refuses a source shorter or longer than its stated size", async () => {
        const plain = random(CHUNK + 10);
        const seal = async (size: number) => (await sealMediaFileStream({size, chunks: [plain]}, company, new ObjectId())).toArray();
        await expect(seal(plain.length + 1)).rejects.toMatchObject({error_code: "health_data_unsealable"});
        await expect(seal(plain.length - 1)).rejects.toMatchObject({error_code: "health_data_unsealable"});
    });

    it("rejects a copy whose source does not open, and keeps none of it in GridFS", async () => {
        const plain = random(Math.floor(3.5 * CHUNK));
        const {mediaId, sealed} = await sealedFile(plain);
        sealed[HEADER + 2 * SEALED_CHUNK + 10] ^= 1;
        await storeHealthFile(mediaId, sealed, plain.length);
        const before = await chunkCount();
        await expect(copyTo(new ObjectId(), mediaId)).rejects.toMatchObject({error_code: "health_data_unreadable"});
        expect(await chunkCount()).toBe(before);
    });
});
