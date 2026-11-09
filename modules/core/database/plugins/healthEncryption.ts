import {Document, Model, MongooseQueryMiddleware, Query, Schema, SchemaType} from "mongoose";
import type {AuditDiffEntry} from "@coreModule/database/schemas/auditLog/auditLog";
import {
    decryptHealthValue,
    encryptHealthValue,
    healthDataUnreadable,
    idString,
    isHealthCiphertext,
} from "@coreModule/utilities/security/healthDataCrypto";

/*
 * Health fields at rest (D102, SEC-06 step 5). Every top-level field marked `sensitivity: "health"` whose value is
 * data (a reference holds only ids; the referenced files are sealed at the media layer) is stored as one ciphertext
 * string and handled by Mongoose as the declared type everywhere else: validation runs on the plaintext, `save`
 * swaps in the ciphertext for the write only, and a load opens it before anyone reads the document.
 * Applied by auditPlugin, which needs the plaintext on both sides of its own hooks.
 */

/** Loads that return documents; their projections and results are handled here. */
const LOADING_QUERIES: MongooseQueryMiddleware[] = ["find", "findOne", "findOneAndUpdate", "findOneAndReplace", "findOneAndDelete", "findOneAndRemove"];
/** Writes that could set a value without `save`, which is the only path that seals it. */
const WRITING_QUERIES: MongooseQueryMiddleware[] = ["updateOne", "updateMany", "update", "findOneAndUpdate", "replaceOne", "findOneAndReplace"];

const pathsBySchema = new WeakMap<Schema, string[]>();
/** Ciphertext a hydrated document was loaded with, opened once the query is done. */
const loadedCiphertext = new WeakMap<Document, Map<string, string>>();
/** Health fields a document was loaded with in plaintext (stored before D102); the next save seals them. */
const loadedPlaintext = new WeakMap<Document, Set<string>>();
/** Plaintext values swapped out for the write, put back when it ends. */
const sealedForSave = new WeakMap<Document, Map<string, unknown>>();
/** Documents being given their opened values, which are not plaintext from storage. */
const opening = new WeakSet<Document>();

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function isReference(schemaType: SchemaType): boolean {
    if (schemaType.options?.ref) return true;
    return schemaType instanceof Schema.Types.Array && !!schemaType.caster?.options?.ref;
}

/** The fields this mechanism seals. A mark below the top level is refused: mark the whole field (SEC-06). */
export function healthFieldPaths(schema: Schema): string[] {
    let paths = pathsBySchema.get(schema);
    if (!paths) {
        const found: string[] = [];
        schema.eachPath((path, schemaType) => {
            if (schemaType.options?.sensitivity !== "health" || isReference(schemaType)) return;
            if (path.includes(".")) throw new Error(`${path}: mark the whole top-level field as health data (SEC-06, D102)`);
            found.push(path);
        });
        paths = found;
        pathsBySchema.set(schema, paths);
    }
    return paths;
}

/** The document's stored state, where `save` reads what it writes. */
function storedState(doc: Document): Record<string, unknown> | undefined {
    const state: unknown = Reflect.get(doc, "_doc");
    return isRecord(state) ? state : undefined;
}

/** A selection of part of a health field loads all of it: only the whole ciphertext opens. */
function selectWholeHealthFields(query: Query<unknown, unknown>, paths: string[]): void {
    const projection: unknown = query.projection();
    if (!isRecord(projection)) return;
    let changed = false;
    const rewritten: Record<string, unknown> = {};
    for (const [field, include] of Object.entries(projection)) {
        const whole = paths.find((path) => field.startsWith(`${path}.`));
        if (whole && (include === 1 || include === true)) {
            rewritten[whole] = 1;
            changed = true;
        } else {
            rewritten[field] = include;
        }
    }
    if (changed) query.projection(rewritten);
}

async function openLoaded(query: Query<unknown, unknown>, result: unknown, paths: string[]): Promise<void> {
    const collection = (query.model as Model<unknown>).collection.name;
    for (const loaded of Array.isArray(result) ? result : [result]) {
        if (loaded instanceof Document) {
            const sealed = loadedCiphertext.get(loaded);
            if (!sealed) continue;
            loadedCiphertext.delete(loaded);
            const opened: Record<string, unknown> = {};
            for (const [path, ciphertext] of sealed) {
                opened[path] = await decryptHealthValue(ciphertext, {company: loaded.get("company") ?? undefined, collection, documentId: loaded._id, path});
            }
            opening.add(loaded);
            try {
                // As if the plaintext had been stored: cast, nothing marked modified.
                loaded.init(opened);
            } finally {
                opening.delete(loaded);
            }
        } else if (isRecord(loaded)) {
            for (const path of paths) {
                const value = loaded[path];
                if (!isHealthCiphertext(value)) continue;
                if (loaded._id === undefined) throw healthDataUnreadable();
                loaded[path] = await decryptHealthValue(value, {company: loaded.company ?? undefined, collection, documentId: idString(loaded._id) ?? "", path});
            }
        }
    }
}

/**
 * Opens health fields on load: lean results in place; hydrated documents get the ciphertext taken out before Mongoose
 * casts it, then the opened value once the query is done. Registered before the sensitive-read audit, which looks
 * at the loaded values.
 */
export function decryptHealthFieldsOnLoad(schema: Schema): void {
    const paths = healthFieldPaths(schema);
    if (paths.length === 0) return;

    schema.pre("init", function (this: Document, ...args: unknown[]) {
        const stored = args[0];
        if (!isRecord(stored) || opening.has(this)) return;
        for (const path of paths) {
            const value = stored[path];
            if (isHealthCiphertext(value)) {
                const sealed = loadedCiphertext.get(this) ?? new Map<string, string>();
                sealed.set(path, value);
                loadedCiphertext.set(this, sealed);
                delete stored[path];
            } else if (value !== undefined && value !== null) {
                const plaintext = loadedPlaintext.get(this) ?? new Set<string>();
                plaintext.add(path);
                loadedPlaintext.set(this, plaintext);
            }
        }
    });

    schema.pre(LOADING_QUERIES, function (this: Query<unknown, unknown>) {
        selectWholeHealthFields(this, paths);
    });

    schema.post(LOADING_QUERIES, async function (this: Query<unknown, unknown>, result: unknown) {
        await openLoaded(this, result, paths);
    });
}

function touchedPaths(update: unknown): string[] {
    if (!isRecord(update)) return [];
    return Object.entries(update).flatMap(([key, value]) => {
        // Removing a value (erasure) needs no key.
        if (key === "$unset") return [];
        if (!key.startsWith("$")) return [key];
        return isRecord(value) ? Object.keys(value) : [];
    });
}

function refuseUnsealedWrite(fields: string[], paths: string[], how: string): void {
    const field = fields.find((candidate) => paths.some((path) => candidate === path || candidate.startsWith(`${path}.`)));
    if (field) throw new Error(`${field} is health data: write it with save(), which encrypts it (D102), not with ${how}`);
}

/**
 * Seals health fields on save, after validation and the audit's diff: a new document, a changed field, or one loaded
 * in plaintext (stored before D102). Writes that bypass `save` with a value are refused.
 */
export function encryptHealthFieldsOnSave(schema: Schema): void {
    const paths = healthFieldPaths(schema);
    if (paths.length === 0) return;

    schema.pre("save", async function (this: Document) {
        const state = storedState(this);
        if (!state) return;
        const plaintextLoaded = loadedPlaintext.get(this);
        const due = paths.filter((path) => (this.isNew || this.isModified(path) || plaintextLoaded?.has(path)) && state[path] != null && !isHealthCiphertext(state[path]));
        if (due.length === 0) return;
        const values = this.toObject({depopulate: true, virtuals: false, getters: false, transform: false});
        const swapped = new Map<string, unknown>();
        sealedForSave.set(this, swapped);
        for (const path of due) {
            const ciphertext = await encryptHealthValue(values[path], {company: this.get("company"), collection: this.collection.name, documentId: this._id, path});
            swapped.set(path, state[path]);
            state[path] = ciphertext;
            // The whole field is one value in storage, even when only part of it changed.
            if (!this.isNew) this.markModified(path);
        }
    });

    const restore = (doc: Document, written: boolean) => {
        const swapped = sealedForSave.get(doc);
        const state = storedState(doc);
        if (!swapped || !state) return;
        for (const [path, value] of swapped) state[path] = value;
        sealedForSave.delete(doc);
        // Stored sealed now; after a failed write the next save seals it again.
        if (written) loadedPlaintext.delete(doc);
    };
    schema.post("save", function (doc: Document) {
        restore(doc, true);
    });
    schema.post("save", function (error: Error, doc: Document, next: (error?: Error) => void) {
        restore(doc, false);
        next(error);
    });

    schema.pre(WRITING_QUERIES, function (this: Query<unknown, unknown>) {
        refuseUnsealedWrite(touchedPaths(this.getUpdate()), paths, "an update query");
    });
    schema.pre("insertMany", function (next, docs: unknown) {
        const list: unknown[] = Array.isArray(docs) ? docs : [docs];
        refuseUnsealedWrite(list.flatMap((doc) => (isRecord(doc) ? Object.keys(doc).filter((key) => doc[key] != null) : [])), paths, "insertMany");
        next();
    });
}

/** Audit diffs keep a health field's values sealed, bound to the audited record and field (SEC-06 step 3). */
export async function encryptHealthDiff(
    schema: Schema,
    diff: Record<string, AuditDiffEntry>,
    record: {company: unknown; collection: string; documentId: unknown},
): Promise<Record<string, AuditDiffEntry>> {
    const paths = healthFieldPaths(schema).filter((path) => diff[path]);
    if (paths.length === 0) return diff;
    const sealed = {...diff};
    const seal = (value: unknown, path: string) => value === null || value === undefined || isHealthCiphertext(value)
        ? Promise.resolve(value)
        : encryptHealthValue(value, {company: idString(record.company) ?? "", collection: record.collection, documentId: idString(record.documentId) ?? "", path});
    for (const path of paths) {
        const entry = diff[path];
        if (entry) sealed[path] = {from: await seal(entry.from, path), to: await seal(entry.to, path)};
    }
    return sealed;
}

/** The plaintext of sealed values in an audit diff, for a reader already allowed to read those fields. */
export async function decryptHealthDiff(
    schema: Schema,
    diff: Record<string, AuditDiffEntry>,
    record: {collection: string; documentId: unknown},
): Promise<Record<string, AuditDiffEntry>> {
    const paths = healthFieldPaths(schema).filter((path) => diff[path]);
    if (paths.length === 0) return diff;
    const opened = {...diff};
    const open = (value: unknown, path: string) => isHealthCiphertext(value)
        ? decryptHealthValue(value, {collection: record.collection, documentId: idString(record.documentId) ?? "", path})
        : Promise.resolve(value);
    for (const path of paths) {
        const entry = diff[path];
        if (entry) opened[path] = {from: await open(entry.from, path), to: await open(entry.to, path)};
    }
    return opened;
}
