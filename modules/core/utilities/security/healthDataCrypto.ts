import crypto from "crypto";
import {Decimal128, ObjectId} from "mongodb";
import {Types} from "mongoose";
import {HEALTH_DATA} from "@coreModule/environment";
import {getLogger} from "@coreModule/loggers/serverLog";
import {requestContext} from "@coreModule/utilities/endpoints/requestContext";
import {withTenant} from "@coreModule/utilities/endpoints/tenantScope";
import {apiValidationException, DEFAULT_EXCEPTION_LANGUAGE} from "armonia/src/modules/core/helpers/exceptions";

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
/** A sealed file: magic, key version (uint32 BE), iv, tag, ciphertext. */
const FILE_MAGIC = Buffer.from("HFE1");
const FILE_HEADER_BYTES = FILE_MAGIC.length + 4 + IV_BYTES + TAG_BYTES;

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

function seal(key: Buffer, plaintext: Buffer, aad: string): Sealed {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {authTagLength: TAG_BYTES});
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {iv, tag: cipher.getAuthTag(), data};
}

/** Null when the tag does not verify: the bytes, the binding or the key differ from the sealing. */
function open(key: Buffer, sealed: Sealed, aad: string): Buffer | null {
    if (sealed.iv.length !== IV_BYTES || sealed.tag.length !== TAG_BYTES) return null;
    try {
        const decipher = crypto.createDecipheriv(ALGORITHM, key, sealed.iv, {authTagLength: TAG_BYTES});
        decipher.setAAD(Buffer.from(aad, "utf8"));
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

/** The bytes to store for a health file (X-ray, photo) of `company`'s media record `mediaId`. */
export async function sealMediaFile(bytes: Buffer, company: unknown, mediaId: Id): Promise<Buffer> {
    const companyId = companyOf({company});
    const {version, key} = await currentDataKey(companyId);
    const {iv, tag, data} = seal(key, bytes, aadOf(companyId, mediaBinding(mediaId)));
    const versionBytes = Buffer.alloc(4);
    versionBytes.writeUInt32BE(version);
    return Buffer.concat([FILE_MAGIC, versionBytes, iv, tag, data]);
}

/** The original bytes of a file sealed by `sealMediaFile`; throws `health_data_unreadable` when they do not open. */
export async function openMediaFile(stored: Buffer, company: unknown, mediaId: Id): Promise<Buffer> {
    const companyId = companyOf({company});
    if (stored.length < FILE_HEADER_BYTES || !stored.subarray(0, FILE_MAGIC.length).equals(FILE_MAGIC)) throw healthDataUnreadable();
    const version = stored.readUInt32BE(FILE_MAGIC.length);
    const ivStart = FILE_MAGIC.length + 4;
    const sealed = {
        iv: stored.subarray(ivStart, ivStart + IV_BYTES),
        tag: stored.subarray(ivStart + IV_BYTES, FILE_HEADER_BYTES),
        data: stored.subarray(FILE_HEADER_BYTES),
    };
    const plaintext = open(await dataKey(companyId, version), sealed, aadOf(companyId, mediaBinding(mediaId)));
    if (!plaintext) {
        logger.err(`Health file of media ${idString(mediaId)} failed authentication`);
        throw healthDataUnreadable();
    }
    return plaintext;
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
