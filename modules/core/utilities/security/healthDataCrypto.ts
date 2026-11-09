import crypto from "crypto";
import {Readable} from "stream";
import {Decimal128, ObjectId} from "mongodb";
import {Types} from "mongoose";
import {HEALTH_DATA} from "@coreModule/environment";
import {getLogger} from "@coreModule/loggers/serverLog";
import {requestContext} from "@coreModule/utilities/endpoints/requestContext";
import {withTenant} from "@coreModule/utilities/endpoints/tenantScope";
import {apiValidationException, DEFAULT_EXCEPTION_LANGUAGE} from "armonia/src/modules/core/helpers/exceptions";
import {ServerError} from "armonia/src/modules/core/types";

/*
 * Health data at rest (D102, SEC-06). Every company has its own AES-256 data key, created on its first encryption and
 * stored wrapped (AES-256-GCM) by the server's master key `HEALTH_DATA_MASTER_KEY`; unwrapped keys stay in memory.
 * Values and files are sealed with AES-256-GCM under the company's current data key, bound (AAD) to the company,
 * collection, record and field, so a ciphertext copied to another record, field or company does not open.
 * Node crypto only.
 */

const logger = getLogger("health_data");

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
/** A sealed field value: `hfe1.<company>.<key version>.<iv>.<tag>.<ciphertext>`, base64url parts. */
const VALUE_PREFIX = "hfe1.";
/** A file sealed whole before TD-B101: magic, key version (uint32 BE), iv, tag, ciphertext. Still read, no longer written. */
const FILE_MAGIC = Buffer.from("HFE1");
const FILE_HEADER_BYTES = FILE_MAGIC.length + 4 + IV_BYTES + TAG_BYTES;
/**
 * A file sealed in chunks (TD-B101), so it can be opened and sent a chunk at a time and by byte range. Header: magic,
 * key version (uint32 BE), company (12-byte id), chunk size (uint32 BE), plaintext size (uint64 BE), base nonce. Then
 * each chunk of `chunk size` plaintext bytes (the last one shorter; an empty file has one empty chunk) as ciphertext
 * followed by its tag. Chunk i is sealed under the base nonce with i XORed into its last 4 bytes, and its AAD binds the
 * record (company, media id), the whole header, i, and whether it is the last chunk: a chunk that is altered, moved,
 * dropped or taken from another file does not open.
 */
const FILE_MAGIC_V2 = Buffer.from("HFE2");
const FILE_V2_HEADER_BYTES = FILE_MAGIC_V2.length + 4 + 12 + 4 + 8 + IV_BYTES;
const FILE_CHUNK_BYTES = 64 * 1024;
/** Enough of a stored health file's first bytes to tell its format and read its header (`readSealedFileHeader`). */
export const HEALTH_FILE_HEADER_BYTES = Math.max(FILE_HEADER_BYTES, FILE_V2_HEADER_BYTES);

type Id = ObjectId | Types.ObjectId | string;

/** What a ciphertext belongs to. Without `company`, a value's own header names it (the AAD still binds it). */
export type HealthBinding = {company: unknown; collection: string; documentId: Id; path: string};

type MasterKey = {id: string; key: Buffer};
type MasterKeys = {current: MasterKey; previous?: MasterKey};
type Sealed = {iv: Buffer; tag: Buffer; data: Buffer};

/** Tampered, moved, or sealed under a key this server does not have: never a 500, never an empty value. */
export function healthDataUnreadable(): ReturnType<typeof apiValidationException> {
    return apiValidationException("health_data_unreadable", "", null, requestContext.getStore()?.languageCode ?? DEFAULT_EXCEPTION_LANGUAGE);
}

/**
 * Health data could not be sealed (key store or master key unavailable): the write is refused, so neither the value
 * nor its change history is ever stored in plaintext or lost (D103).
 */
export function healthDataUnsealable(): ReturnType<typeof apiValidationException> {
    return apiValidationException("health_data_unsealable", "", null, requestContext.getStore()?.languageCode ?? DEFAULT_EXCEPTION_LANGUAGE);
}

/** Seals with `seal`, turning any failure that is not already a keyed API error into `health_data_unsealable`. */
export async function sealOrRefuse<T>(seal: () => Promise<T>, what: string): Promise<T> {
    try {
        return await seal();
    } catch (error) {
        if (error instanceof ServerError) throw error;
        logger.err(`Could not seal ${what}: ${error instanceof Error ? error.message : String(error)}`);
        throw healthDataUnsealable();
    }
}

/** The hex id of a company or record, whether held as an id, a string or a populated document. */
export function idString(value: unknown): string | undefined {
    if (value instanceof ObjectId || value instanceof Types.ObjectId) return value.toHexString();
    if (typeof value === "string") return ObjectId.isValid(value) ? value : undefined;
    if (value && typeof value === "object" && "_id" in value) return idString(value._id);
    return undefined;
}

function masterKeyOf(base64: string): MasterKey {
    const key = Buffer.from(base64.trim(), "base64");
    if (key.length !== KEY_BYTES) throw new Error("A health-data master key must be 32 bytes in base64 (D102)");
    return {id: crypto.createHash("sha256").update(key).digest("hex").slice(0, 16), key};
}

function configuredMasterKeys(): MasterKeys {
    if (!HEALTH_DATA.MASTER_KEY) throw new Error("HEALTH_DATA_MASTER_KEY is not configured: health data cannot be encrypted or read (D102)");
    return {
        current: masterKeyOf(HEALTH_DATA.MASTER_KEY),
        ...(HEALTH_DATA.MASTER_KEY_PREVIOUS ? {previous: masterKeyOf(HEALTH_DATA.MASTER_KEY_PREVIOUS)} : {}),
    };
}

const b64 = (bytes: Buffer) => bytes.toString("base64url");
const fromB64 = (text: string) => Buffer.from(text, "base64url");

const aadBytes = (aad: string | Buffer) => (typeof aad === "string" ? Buffer.from(aad, "utf8") : aad);

function seal(key: Buffer, plaintext: Buffer, aad: string | Buffer, iv: Buffer = crypto.randomBytes(IV_BYTES)): Sealed {
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {authTagLength: TAG_BYTES});
    cipher.setAAD(aadBytes(aad));
    const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {iv, tag: cipher.getAuthTag(), data};
}

/** Null when the tag does not verify: the bytes, the binding or the key differ from the sealing. */
function open(key: Buffer, sealed: Sealed, aad: string | Buffer): Buffer | null {
    if (sealed.iv.length !== IV_BYTES || sealed.tag.length !== TAG_BYTES) return null;
    try {
        const decipher = crypto.createDecipheriv(ALGORITHM, key, sealed.iv, {authTagLength: TAG_BYTES});
        decipher.setAAD(aadBytes(aad));
        decipher.setAuthTag(sealed.tag);
        return Buffer.concat([decipher.update(sealed.data), decipher.final()]);
    } catch {
        return null;
    }
}

const aadOf = (company: string, binding: Omit<HealthBinding, "company">) =>
    `${company}|${binding.collection}|${idString(binding.documentId) ?? ""}|${binding.path}`;
const wrapAad = (company: string, version: number) => `company-data-key|${company}|${version}`;

function wrapDataKey(key: Buffer, master: MasterKey, company: string, version: number): string {
    const {iv, tag, data} = seal(master.key, key, wrapAad(company, version));
    return [iv, tag, data].map(b64).join(".");
}

function unwrapDataKey(record: {wrappedKey: string; masterKeyId: string; version: number}, company: string, masters: MasterKeys): Buffer {
    const master = [masters.current, masters.previous].find((candidate) => candidate?.id === record.masterKeyId);
    const [iv, tag, data] = record.wrappedKey.split(".").map(fromB64);
    const key = master && iv && tag && data ? open(master.key, {iv, tag, data}, wrapAad(company, record.version)) : null;
    if (!key) {
        logger.err(`Health data key v${record.version} of company ${company} does not open with the configured master keys`);
        throw healthDataUnreadable();
    }
    return key;
}

/** Unwrapped data keys by company, then version. */
const dataKeys = new Map<string, Map<number, Buffer>>();

// Loaded on use: the key model applies auditPlugin, which applies the health hooks that call this module.
const keyService = async () => (await import("@coreModule/database/schemas/companyDataKey/companyDataKey.service")).companyDataKeyService;

async function loadCompanyKeys(company: string): Promise<Map<number, Buffer>> {
    const service = await keyService();
    const masters = configuredMasterKeys();
    // Outside the caller's transaction: a key, once made, is kept whatever happens to the write that needed it.
    const records = await withTenant(company, () => service.findForCompany(new Types.ObjectId(company)));
    const keys = dataKeys.get(company) ?? new Map<number, Buffer>();
    for (const record of records) {
        if (!keys.has(record.version)) keys.set(record.version, unwrapDataKey(record, company, masters));
    }
    dataKeys.set(company, keys);
    return keys;
}

const isDuplicateKey = (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === 11000;

async function currentDataKey(company: string): Promise<{version: number; key: Buffer}> {
    let keys = dataKeys.get(company);
    if (!keys?.size) keys = await loadCompanyKeys(company);
    if (!keys.size) {
        const {current} = configuredMasterKeys();
        const service = await keyService();
        try {
            await withTenant(company, () => service.create({
                company: new Types.ObjectId(company), version: 1, wrappedKey: wrapDataKey(crypto.randomBytes(KEY_BYTES), current, company, 1), masterKeyId: current.id,
            }));
        } catch (error) {
            // Another server made the company's first key at the same moment: use that one.
            if (!isDuplicateKey(error)) throw error;
        }
        keys = await loadCompanyKeys(company);
    }
    let latest: {version: number; key: Buffer} | undefined;
    for (const [version, key] of keys) if (!latest || version > latest.version) latest = {version, key};
    if (!latest) throw new Error(`No health data key for company ${company}`);
    return latest;
}

async function dataKey(company: string, version: number): Promise<Buffer> {
    const key = dataKeys.get(company)?.get(version) ?? (await loadCompanyKeys(company)).get(version);
    if (!key) {
        logger.err(`Company ${company} has no health data key v${version}`);
        throw healthDataUnreadable();
    }
    return key;
}

function companyOf(binding: {company?: unknown}): string {
    const company = idString(binding.company);
    if (!company) throw new Error("Health data is encrypted with its company's key: the record has no company");
    return company;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** JSON that keeps dates, ids and decimals as they were (Extended JSON tags), so a lean read gets stored types back. */
function encodeValue(value: unknown): Buffer {
    return Buffer.from(JSON.stringify({v: value}, function (this: unknown, key: string, encoded: unknown) {
        // `encoded` has been through toJSON already; the holder still has the original.
        const original: unknown = this && typeof this === "object" ? Reflect.get(this, key) : encoded;
        if (original instanceof Date) return {$date: original.toISOString()};
        if (original instanceof ObjectId || original instanceof Types.ObjectId) return {$oid: original.toHexString()};
        if (original instanceof Decimal128 || original instanceof Types.Decimal128) return {$numberDecimal: original.toString()};
        return encoded;
    }), "utf8");
}

function decodeValue(bytes: Buffer): unknown {
    const parsed: unknown = JSON.parse(bytes.toString("utf8"), (_key, value: unknown) => {
        if (!isRecord(value) || Object.keys(value).length !== 1) return value;
        if (typeof value.$date === "string") return new Date(value.$date);
        if (typeof value.$oid === "string") return new ObjectId(value.$oid);
        if (typeof value.$numberDecimal === "string") return Decimal128.fromString(value.$numberDecimal);
        return value;
    });
    return isRecord(parsed) ? parsed.v : undefined;
}

/** True for a value sealed by `encryptHealthValue`; anything else in a health field is plaintext from before D102. */
export function isHealthCiphertext(value: unknown): value is string {
    return typeof value === "string" && value.startsWith(VALUE_PREFIX);
}

/** Seals a field's whole value (as JSON that keeps dates and ids) with the company's current key. */
export async function encryptHealthValue(value: unknown, binding: HealthBinding): Promise<string> {
    const company = companyOf(binding);
    const {version, key} = await currentDataKey(company);
    const {iv, tag, data} = seal(key, encodeValue(value), aadOf(company, binding));
    return `${VALUE_PREFIX}${company}.${version}.${b64(iv)}.${b64(tag)}.${b64(data)}`;
}

/** Opens a value sealed by `encryptHealthValue` for the same record and field; throws `health_data_unreadable` otherwise. */
export async function decryptHealthValue(ciphertext: string, binding: Omit<HealthBinding, "company"> & {company?: unknown}): Promise<unknown> {
    const [company, versionText, iv, tag, data] = ciphertext.slice(VALUE_PREFIX.length).split(".");
    const version = Number(versionText);
    const expected = binding.company === undefined ? company : idString(binding.company);
    if (!company || !ObjectId.isValid(company) || company !== expected || !Number.isInteger(version) || version < 1 || !iv || !tag || data === undefined) {
        throw healthDataUnreadable();
    }
    const plaintext = open(await dataKey(company, version), {iv: fromB64(iv), tag: fromB64(tag), data: fromB64(data)}, aadOf(company, binding));
    if (!plaintext) {
        // Never the value: only which record and field failed.
        logger.err(`Health data in ${binding.collection} ${idString(binding.documentId)} (${binding.path}) failed authentication`);
        throw healthDataUnreadable();
    }
    return decodeValue(plaintext);
}

const mediaBinding = (mediaId: Id) => ({collection: "media", documentId: mediaId, path: "file"});

/** A stored health file's format, from `readSealedFileHeader`. */
export type SealedFile = {format: 1} | SealedFileV2;
export type SealedFileV2 = {format: 2; header: Buffer; company: string; version: number; chunkSize: number; size: number; baseNonce: Buffer};
/** The stored bytes (inclusive) holding plaintext bytes `skip`… of chunk `firstChunk` through chunk `lastChunk`, `length` bytes in all. */
export type SealedSpan = {stored: {start: number; end: number}; firstChunk: number; lastChunk: number; skip: number; length: number};

const chunkCount = (file: SealedFileV2) => Math.max(1, Math.ceil(file.size / file.chunkSize));
const chunkPlainBytes = (file: SealedFileV2, index: number) => Math.max(0, Math.min(file.chunkSize, file.size - index * file.chunkSize));
const storedLengthOf = (file: SealedFileV2) => file.header.length + file.size + chunkCount(file) * TAG_BYTES;

function chunkNonce(baseNonce: Buffer, index: number): Buffer {
    const nonce = Buffer.from(baseNonce);
    nonce.writeUInt32BE((nonce.readUInt32BE(IV_BYTES - 4) ^ index) >>> 0, IV_BYTES - 4);
    return nonce;
}

function chunkAad(binding: string, header: Buffer, index: number, last: boolean): Buffer {
    const position = Buffer.alloc(5);
    position.writeUInt32BE(index);
    position[4] = last ? 1 : 0;
    return Buffer.concat([Buffer.from(binding, "utf8"), header, position]);
}

/** A file's plaintext as it is read, in pieces of any size, with its length known up front (the HFE2 header carries it). */
export type MediaPlaintext = {size: number; chunks: AsyncIterable<Buffer> | Iterable<Buffer>};

/**
 * Format 2: the header, then each chunk sealed as it is pulled from `plaintext`, so the stored form never exists whole
 * in memory, and a streamed plaintext never does either (one chunk plus one incoming piece at most). A source that
 * yields more or fewer bytes than `plaintext.size` throws `health_data_unsealable`: the header would not describe it.
 */
async function sealedMediaFileParts(plaintext: MediaPlaintext, company: unknown, mediaId: Id): Promise<AsyncGenerator<Buffer>> {
    const companyId = companyOf({company});
    const {version, key} = await currentDataKey(companyId);
    const header = Buffer.alloc(FILE_V2_HEADER_BYTES);
    FILE_MAGIC_V2.copy(header, 0);
    header.writeUInt32BE(version, 4);
    Buffer.from(companyId, "hex").copy(header, 8);
    header.writeUInt32BE(FILE_CHUNK_BYTES, 20);
    header.writeBigUInt64BE(BigInt(plaintext.size), 24);
    crypto.randomBytes(IV_BYTES).copy(header, 32);
    const file: SealedFileV2 = {format: 2, header, company: companyId, version, chunkSize: FILE_CHUNK_BYTES, size: plaintext.size, baseNonce: header.subarray(32)};
    const binding = aadOf(companyId, mediaBinding(mediaId));
    const total = chunkCount(file);
    const sealChunk = (index: number, bytes: Buffer): Buffer => {
        const {tag, data} = seal(key, bytes, chunkAad(binding, header, index, index === total - 1), chunkNonce(file.baseNonce, index));
        return Buffer.concat([data, tag]);
    };
    const refuseLength = (received: number): never => {
        logger.err(`Health file of media ${idString(mediaId)} to seal ${received < file.size ? "ended at" : "ran past"} ${received} of ${file.size} bytes`);
        throw healthDataUnsealable();
    };
    return (async function* () {
        yield header;
        let index = 0;
        let received = 0;
        let pending: Buffer = Buffer.alloc(0);
        for await (const piece of plaintext.chunks) {
            received += piece.length;
            if (received > file.size) refuseLength(received);
            pending = pending.length ? Buffer.concat([pending, piece]) : piece;
            // The last chunk waits for the end of the source: only then is it known to be complete.
            for (; index < total - 1 && pending.length >= file.chunkSize; index++) {
                yield sealChunk(index, pending.subarray(0, file.chunkSize));
                pending = pending.subarray(file.chunkSize);
            }
        }
        if (received !== file.size) refuseLength(received);
        yield sealChunk(total - 1, pending);
    })();
}

const wholePlaintext = (bytes: Buffer): MediaPlaintext => ({size: bytes.length, chunks: [bytes]});

/** The bytes to store for a health file (X-ray, photo) of `company`'s media record `mediaId`. */
export async function sealMediaFile(bytes: Buffer, company: unknown, mediaId: Id): Promise<Buffer> {
    const parts: Buffer[] = [];
    for await (const part of await sealedMediaFileParts(wholePlaintext(bytes), company, mediaId)) parts.push(part);
    return Buffer.concat(parts);
}

/**
 * `sealMediaFile` as a stream to hand to GridFS: each chunk is sealed as the upload pulls it (TD-B101). Given a
 * streamed plaintext (a server-side copy, `readMediaStream`), the plaintext is pulled as the upload goes too (TD-B111).
 */
export async function sealMediaFileStream(plaintext: Buffer | MediaPlaintext, company: unknown, mediaId: Id): Promise<Readable> {
    const source = Buffer.isBuffer(plaintext) ? wholePlaintext(plaintext) : plaintext;
    return Readable.from(await sealedMediaFileParts(source, company, mediaId), {objectMode: false});
}

function refuseFile(mediaId: Id, reason: string): never {
    logger.err(`Health file of media ${idString(mediaId)} ${reason}`);
    throw healthDataUnreadable();
}

/**
 * A stored health file's format, from its first `HEALTH_FILE_HEADER_BYTES` (or all of it, when shorter) and its stored
 * length. A format-2 header must name the media's company and account for exactly `storedLength` bytes, so a truncated
 * or extended file is refused before anything is opened; the header's fields are authenticated by every chunk.
 * Throws `health_data_unreadable` for anything else.
 */
export function readSealedFileHeader(prefix: Buffer, storedLength: number, company: unknown, mediaId: Id): SealedFile {
    const companyId = companyOf({company});
    if (prefix.length >= FILE_HEADER_BYTES && prefix.subarray(0, FILE_MAGIC.length).equals(FILE_MAGIC)) return {format: 1};
    if (prefix.length < FILE_V2_HEADER_BYTES || !prefix.subarray(0, FILE_MAGIC_V2.length).equals(FILE_MAGIC_V2)) refuseFile(mediaId, "is not a sealed file");
    const header = Buffer.from(prefix.subarray(0, FILE_V2_HEADER_BYTES));
    const size = header.readBigUInt64BE(24);
    const file: SealedFileV2 = {
        format: 2,
        header,
        company: header.subarray(8, 20).toString("hex"),
        version: header.readUInt32BE(4),
        chunkSize: header.readUInt32BE(20),
        size: Number(size),
        baseNonce: header.subarray(32, FILE_V2_HEADER_BYTES),
    };
    if (file.company !== companyId || file.version < 1 || file.chunkSize < 1 || size > BigInt(Number.MAX_SAFE_INTEGER)) refuseFile(mediaId, "has an invalid header");
    if (storedLengthOf(file) !== storedLength) refuseFile(mediaId, `is ${storedLength} bytes, its header accounts for ${storedLengthOf(file)}`);
    return file;
}

/** Where plaintext bytes `range` (inclusive; the whole file without one) of `file` are stored. */
export function sealedSpanOf(file: SealedFileV2, range?: {start: number; end: number}): SealedSpan {
    const start = range?.start ?? 0;
    const end = range?.end ?? file.size - 1;
    const firstChunk = Math.floor(start / file.chunkSize);
    const lastChunk = file.size === 0 ? 0 : Math.floor(end / file.chunkSize);
    const sealedChunk = file.chunkSize + TAG_BYTES;
    return {
        stored: {
            start: file.header.length + firstChunk * sealedChunk,
            end: file.header.length + lastChunk * sealedChunk + chunkPlainBytes(file, lastChunk) + TAG_BYTES - 1,
        },
        firstChunk,
        lastChunk,
        skip: start - firstChunk * file.chunkSize,
        length: file.size === 0 ? 0 : end - start + 1,
    };
}

/**
 * Opens the chunks of `span` from `stored` (the stored bytes `span.stored`, in pieces of any size), yielding each
 * chunk's plaintext, cut to the span, only after its tag verifies. Holds one chunk plus one incoming piece at most. A
 * chunk that does not open, or a source that ends early, throws `health_data_unreadable`: nothing after the last
 * verified chunk is ever yielded.
 */
export async function* openMediaFileChunks(stored: AsyncIterable<Buffer> | Iterable<Buffer>, file: SealedFileV2, mediaId: Id, span: SealedSpan): AsyncGenerator<Buffer> {
    const key = await dataKey(file.company, file.version);
    const binding = aadOf(file.company, mediaBinding(mediaId));
    const total = chunkCount(file);
    let index = span.firstChunk;
    let sent = 0;
    let pending: Buffer = Buffer.alloc(0);
    for await (const piece of stored) {
        pending = pending.length ? Buffer.concat([pending, piece]) : piece;
        for (let need = chunkPlainBytes(file, index) + TAG_BYTES; index <= span.lastChunk && pending.length >= need; need = chunkPlainBytes(file, index) + TAG_BYTES) {
            const dataBytes = need - TAG_BYTES;
            const sealed = {iv: chunkNonce(file.baseNonce, index), tag: pending.subarray(dataBytes, need), data: pending.subarray(0, dataBytes)};
            const plaintext = open(key, sealed, chunkAad(binding, file.header, index, index === total - 1));
            if (!plaintext) refuseFile(mediaId, `failed authentication at chunk ${index}`);
            const from = index === span.firstChunk ? span.skip : 0;
            const part = plaintext.subarray(from, from + span.length - sent);
            pending = pending.subarray(need);
            sent += part.length;
            index += 1;
            if (part.length) yield part;
        }
        if (index > span.lastChunk) return;
    }
    if (index <= span.lastChunk) refuseFile(mediaId, `ended before chunk ${index}`);
}

function openMediaFileV1(stored: Buffer, key: Buffer, companyId: string, mediaId: Id): Buffer {
    const ivStart = FILE_MAGIC.length + 4;
    const sealed = {
        iv: stored.subarray(ivStart, ivStart + IV_BYTES),
        tag: stored.subarray(ivStart + IV_BYTES, FILE_HEADER_BYTES),
        data: stored.subarray(FILE_HEADER_BYTES),
    };
    return open(key, sealed, aadOf(companyId, mediaBinding(mediaId))) ?? refuseFile(mediaId, "failed authentication");
}

/** The original bytes of a file sealed by `sealMediaFile` (either format); throws `health_data_unreadable` when they do not open. */
export async function openMediaFile(stored: Buffer, company: unknown, mediaId: Id): Promise<Buffer> {
    const companyId = companyOf({company});
    const file = readSealedFileHeader(stored.subarray(0, HEALTH_FILE_HEADER_BYTES), stored.length, companyId, mediaId);
    if (file.format === 1) return openMediaFileV1(stored, await dataKey(companyId, stored.readUInt32BE(FILE_MAGIC.length)), companyId, mediaId);
    const parts: Buffer[] = [];
    for await (const part of openMediaFileChunks([stored.subarray(file.header.length)], file, mediaId, sealedSpanOf(file))) parts.push(part);
    return Buffer.concat(parts);
}

/**
 * Master-key rotation (D102): rewraps every company's data keys that are not under the current master key, unwrapping
 * them with the previous one. The data itself is untouched. Run cross-tenant by the operator script
 * `npm run health:rewrap-keys`; returns how many keys it rewrapped.
 */
export async function rewrapCompanyDataKeys(keys: {current?: string; previous?: string} = {current: HEALTH_DATA.MASTER_KEY, previous: HEALTH_DATA.MASTER_KEY_PREVIOUS}): Promise<number> {
    if (!keys.current) throw new Error("HEALTH_DATA_MASTER_KEY is not configured");
    const masters: MasterKeys = {current: masterKeyOf(keys.current), ...(keys.previous ? {previous: masterKeyOf(keys.previous)} : {})};
    const service = await keyService();
    const records = await service.findWrappedByOtherMasterKey(masters.current.id);
    for (const record of records) {
        const company = companyOf(record);
        const key = unwrapDataKey(record, company, masters);
        await service.rewrap(record._id, wrapDataKey(key, masters.current, company, record.version), masters.current.id);
    }
    return records.length;
}
