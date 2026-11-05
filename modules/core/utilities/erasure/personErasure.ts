import fs from "fs";
import path from "path";
import {ClientSession, Types} from "mongoose";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {isModuleEnabled} from "@coreModule/utilities/modules/enabledModules";
import {runAfterCommit} from "@coreModule/utilities/middlewares/transactionUtils";
import {mediaService} from "@coreModule/database/schemas/media/media.service";
import {auditLogService} from "@coreModule/database/schemas/auditLog/auditLog.service";
import {getGridFSStorage} from "@coreModule/utilities/gridfs/gridfsStorage";

/**
 * Person erasure (D57, SEC-06): a company admin erases one person from that company's records. Each module plugs in an
 * eraser for its own collections; core runs them in one transaction, then deletes the special-category files they
 * hand back and blanks those fields' values in past audit diffs.
 *
 * Erasers anonymise records the business must keep (personal fields become "Erased person"; numbers, dates and amounts
 * stay) and hard-delete special-category data. They never touch the person's login account or other companies' data.
 */

/** Ids of documents, or of references that are not populated (for erasers collecting what to change). */
export function objectIds(values: readonly unknown[] | undefined): Types.ObjectId[] {
    const toId = (value: unknown): Types.ObjectId | undefined => {
        if (value instanceof Types.ObjectId) return value;
        if (value && typeof value === "object" && "_id" in value && value._id instanceof Types.ObjectId) return value._id;
        return undefined;
    };
    return (values ?? []).map(toId).filter((id): id is Types.ObjectId => !!id);
}

/** Who to erase: their portal accounts and email addresses (lower-cased). */
export type ErasureSubject = {accountIds: Types.ObjectId[]; emails: string[]};

/** What one eraser found (and, unless previewing, changed) in one collection. */
export type ErasureCount = {collection: string; anonymised: number; deleted: number};

export type ErasureContext = {
    companyId: Types.ObjectId;
    subject: ErasureSubject;
    /** Count what would change, change nothing. */
    preview: boolean;
    session?: ClientSession;
    logger: serverLogger;
    /** Media to delete for good with its stored file (special-category files). */
    deleteMedia: (ids: Types.ObjectId[]) => void;
    /**
     * Blank the stored values of these fields in past audit diffs of these records; `"all"` for records the eraser
     * deleted, whose whole history was about the person.
     */
    scrubAudit: (collectionName: string, documentIds: Types.ObjectId[], fields: string[] | "all") => void;
};

export type PersonEraser = {module: string; erase: (ctx: ErasureContext) => Promise<ErasureCount[]>};

/** The name anonymised records show instead of the person's (as one field, or split into first and last). */
export const ERASED_NAME = "Erased person";
export const ERASED_FIRST_NAME = "Erased";
export const ERASED_LAST_NAME = "person";
/** Stands in for a required phone number. */
export const ERASED_PHONE = "-";
/** Stands in for any other required text, such as a street. */
export const ERASED_TEXT = "-";
/** Stands in for a required email; `.invalid` can never be delivered. */
export const ERASED_EMAIL = "erased@erased.invalid";

const erasers: PersonEraser[] = [];

/** Registers a module's eraser. Modules call this from `register*PersonErasers()` in `{module}/utilities/erasure/`. */
export function registerPersonEraser(eraser: PersonEraser): void {
    if (!erasers.some((existing) => existing.module === eraser.module)) erasers.push(eraser);
}

// `register<Module>PersonErasers`; core's own `registerPersonEraser` (singular) must not match.
const REGISTER_FN_PATTERN = /^register.+PersonErasers$/;
let loaded = false;

/**
 * Finds every enabled module's erasers, once (same discovery as cron handlers). Their imports register the modules'
 * models; a server has them all from start-up, a test loads them before building indexes.
 */
export async function loadPersonErasers(logger: serverLogger = getLogger("person_erasure")): Promise<void> {
    if (loaded) return;
    loaded = true;
    const modulesPath = path.resolve(__dirname, "../../..");
    for (const entry of fs.readdirSync(modulesPath, {withFileTypes: true})) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || !isModuleEnabled(entry.name)) continue;
        const dir = path.join(modulesPath, entry.name, "utilities", "erasure");
        if (!fs.existsSync(dir)) continue;
        for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".ts") && !name.endsWith(".d.ts"))) {
            const exports: Record<string, unknown> = await import(path.join(dir, file));
            for (const [name, value] of Object.entries(exports)) {
                if (typeof value === "function" && REGISTER_FN_PATTERN.test(name)) (value as () => void)();
            }
        }
    }
    logger.debug(`Person erasers: ${erasers.map((eraser) => eraser.module).join(", ") || "none"}`);
}

/**
 * Modules that can erase a person's data: a company's admins get the erasure screen only when it has one (D57).
 * Core's own eraser (website chats) runs wherever erasure is offered but does not offer it: every company has core.
 */
export async function personErasureModules(): Promise<string[]> {
    await loadPersonErasers();
    return erasers.map((eraser) => eraser.module).filter((name) => name !== "core");
}

/** The person as they are written in records: trimmed, lower-cased emails and account ids. */
export function erasureSubject(input: {accountIds?: string[]; emails?: string[]}): ErasureSubject {
    return {
        accountIds: (input.accountIds ?? []).filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id)),
        emails: [...new Set((input.emails ?? []).map((email) => email.trim().toLowerCase()).filter(Boolean))],
    };
}

/**
 * Erases one person from one company's records with every registered eraser. Run inside the request's transaction;
 * stored files are deleted after it commits. With `preview`, only counts.
 */
export async function erasePersonInCompany(params: {
    companyId: Types.ObjectId;
    subject: ErasureSubject;
    preview: boolean;
    /** The admin erasing, recorded on every record they erased (ERASE audit entry). */
    actorId?: Types.ObjectId;
    session?: ClientSession;
    logger?: serverLogger;
}): Promise<ErasureCount[]> {
    const logger = getLogger("person_erasure", params.logger);
    await loadPersonErasers(logger);
    if (params.subject.accountIds.length === 0 && params.subject.emails.length === 0) return [];

    const mediaIds: Types.ObjectId[] = [];
    const audit: {collectionName: string; documentIds: Types.ObjectId[]; fields: string[] | "all"}[] = [];
    const ctx: ErasureContext = {
        companyId: params.companyId,
        subject: params.subject,
        preview: params.preview,
        session: params.session,
        logger,
        deleteMedia: (ids) => mediaIds.push(...ids),
        scrubAudit: (collectionName, documentIds, fields) => {
            if (documentIds.length > 0 && fields.length > 0) audit.push({collectionName, documentIds, fields});
        },
    };

    const counts: ErasureCount[] = [];
    for (const eraser of erasers) counts.push(...await eraser.erase(ctx));

    const media = mediaIds.length > 0
        ? await mediaService.find({_id: {$in: mediaIds}, company: params.companyId}, {session: params.session, withDeleted: true}, undefined, "_id fileId")
        : [];
    counts.push({collection: "media", anonymised: 0, deleted: media.length});
    if (params.preview) return counts;

    // Special-category values in old change history: keep that a change happened, drop what it was.
    // Each erased record says who erased it and when (TD-B34), without anything about the person.
    const erasedAt = new Date();
    const erasures = audit.flatMap(({collectionName, documentIds}) => documentIds.map((documentId) => ({
        company: params.companyId, collectionName, documentId, actorId: params.actorId, action: "ERASE", diff: {}, createdAt: erasedAt, updatedAt: erasedAt,
    })));
    for (const {collectionName, documentIds, fields} of audit) {
        if (fields === "all") {
            await auditLogService.blankAllDiffValues(params.companyId, collectionName, documentIds, params.session);
            continue;
        }
        for (const field of fields) {
            // Only entries that recorded this field: blanking must not invent changes.
            await auditLogService.eraseFields(
                {company: params.companyId, collectionName, documentId: {$in: documentIds}, [`diff.${field}`]: {$exists: true}},
                {$set: {[`diff.${field}.from`]: null, [`diff.${field}.to`]: null}},
                {session: params.session},
            );
        }
    }
    if (erasures.length > 0) await auditLogService.recordErasures(erasures, params.session);
    if (media.length > 0) {
        await mediaService.deleteMany({_id: {$in: media.map((item) => item._id)}, company: params.companyId}, {session: params.session, hard: true});
        // A file's history (its name, often the person's) goes with it.
        await auditLogService.blankAllDiffValues(params.companyId, "media", objectIds(media), params.session);
        const fileIds = media.map((item) => item.fileId).filter((id): id is Types.ObjectId => !!id);
        await runAfterCommit(params.session, async () => {
            const gridfs = getGridFSStorage("en-US", "media", logger);
            for (const fileId of fileIds) {
                await gridfs.deleteFile(fileId.toString()).catch((error: unknown) => logger.warn(`Erased media file ${fileId} was not deleted: ${error}`));
            }
        });
    }
    logger.info(`Erased a person in company ${params.companyId}: ${counts.map((count) => `${count.collection} ${count.anonymised}/${count.deleted}`).join(", ")}`);
    return counts;
}
