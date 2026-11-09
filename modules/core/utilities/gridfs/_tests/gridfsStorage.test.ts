import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {Readable} from "stream";
import mongoose from "mongoose";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";
import {GridFSStorage} from "@coreModule/utilities/gridfs/gridfsStorage";

const BUCKET = "gridfsSizeTest";
// Above two GridFS chunks (255 KiB each), so chunks are already written when the limit is crossed.
const MAX = 600 * 1024;

/** A source of `total` bytes in 16 KiB pieces, read lazily like an upload or a decrypting copy. */
function source(total: number): Readable {
    let sent = 0;
    return new Readable({
        read() {
            if (sent >= total) return this.push(null);
            const size = Math.min(16 * 1024, total - sent);
            sent += size;
            this.push(Buffer.alloc(size, 7));
        },
    });
}

beforeAll(async () => {
    await connectTestDatabase();
}, 120000);

afterAll(async () => {
    await disconnectTestDatabase();
});

describe("GridFSStorage.uploadFile size limit (TD-B113)", {timeout: 30000}, () => {
    it("refuses a stream over the limit and leaves no chunks behind", async () => {
        const storage = new GridFSStorage("en-US", BUCKET, undefined, MAX);

        await expect(storage.uploadFile(source(MAX * 4), "too-big.bin")).rejects.toMatchObject({error_code: "file_size_exceeds_limit"});

        // Let chunk writes already in flight land before counting what was left behind.
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const db = mongoose.connection.db;
        expect(await db.collection(`${BUCKET}.chunks`).countDocuments({})).toBe(0);
        expect(await db.collection(`${BUCKET}.files`).countDocuments({})).toBe(0);
    });

    it("still stores a stream within the limit", async () => {
        const storage = new GridFSStorage("en-US", BUCKET, undefined, MAX);

        const id = await storage.uploadFile(source(MAX - 1), "fits.bin");

        const stored = await mongoose.connection.db.collection(`${BUCKET}.files`).findOne({_id: id});
        expect(stored?.length).toBe(MAX - 1);
    });
});
