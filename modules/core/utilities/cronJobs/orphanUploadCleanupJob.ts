/**
 * Orphaned upload sweep.
 *
 * Forms upload their files first (`POST /api/auxiliary/media/upload-batch`) and submit the
 * returned ids afterwards. When that submit fails or is abandoned, the Media document and its
 * GridFS file are left behind. Such uploads are created with `pendingReference: true`; this job
 * looks at the ones older than the grace window and, for each:
 *   - referenced anywhere → clears the flag (it is in use and never checked again);
 *   - referenced nowhere  → deletes the Media document and its GridFS file.
 *
 * "Referenced" is checked against every registered schema, including soft-deleted records (a
 * restore would bring the reference back):
 *   - every path typed as a Media ObjectId, however deeply nested, and arrays of them;
 *   - the JSON of every `Mixed` path, except in log / cache collections, since free-form
 *     content (e.g. a CMS block's config) may carry a media id as text.
 *
 * Media created any other way never has the flag, so it is never touched. When in doubt the
 * job keeps the file: a leftover upload costs storage, a wrongly deleted one loses data.
 *
 * @module orphanUploadCleanupJob
 */

import mongoose, {Model, Schema, SchemaType} from "mongoose";
import {ObjectId} from "mongodb";
import Media from "@coreModule/database/schemas/media/media";
import {getGridFSStorage} from "@coreModule/utilities/gridfs/gridfsStorage";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {getAllModels} from "@initializer";

/** Uploads younger than this are left alone: their form may still be on its way. */
export const ORPHAN_UPLOAD_GRACE_HOURS = 24;
const BATCH_SIZE = 200;
/** Caps one run; the next run continues where this one stopped. */
const MAX_BATCHES_PER_RUN = 10;

/** Collections whose free-form fields record past events rather than live content. */
const MIXED_SCAN_EXCLUDED_MODELS = new Set([
    "AuditLog",
    "CronExecution",
    "DashboardCache",
    "Notification",
    "PaymentTransaction",
    "SwissOutreachPipelineRunLog",
]);

export type ModelPath = {model: Model<any>; path: string};

export type OrphanUploadCleanupResult = {
    examined: number;
    claimed: number;
    deleted: number;
    failed: number;
};

export type OrphanUploadCleanupOptions = {
    graceHours?: number;
    now?: Date;
    signal?: AbortSignal;
    /** Defaults to every model registered with mongoose. */
    models?: Model<any>[];
    /** Defaults to GridFS `media` bucket deletion. */
    deleteFile?: (fileId: string) => Promise<void>;
};

function refName(ref: unknown): string | undefined {
    if (typeof ref === "string") return ref;
    if (typeof ref === "function" && "modelName" in ref) return (ref as {modelName: string}).modelName;
    return undefined;
}

const isMediaRef = (type: SchemaType | undefined): boolean =>
    type?.instance === "ObjectID" && refName((type as any).options?.ref) === Media.modelName;

/** Visits every leaf path of `schema`, descending into sub-documents and document arrays. */
function walkSchema(schema: Schema, prefix: string, visit: (path: string, type: SchemaType) => void): void {
    schema.eachPath((name, type) => {
        const path = prefix + name;
        visit(path, type);
        const nested = (type as any).schema as Schema | undefined;
        if (nested) walkSchema(nested, `${path}.`, visit);
    });
}

/** Every query path, in any of `models`, that stores a Media id (directly or in an array). */
export function findMediaReferencePaths(models: Model<any>[]): ModelPath[] {
    const found: ModelPath[] = [];
    for (const model of models) {
        if (model.modelName === Media.modelName) continue;
        walkSchema(model.schema, "", (path, type) => {
            if (isMediaRef(type) || (type.instance === "Array" && isMediaRef((type as any).caster))) {
                found.push({model, path});
            }
        });
    }
    return found;
}

/** Every `Mixed` path (or array of `Mixed`) outside the excluded log / cache models. */
export function findMixedContentPaths(models: Model<any>[]): ModelPath[] {
    const found: ModelPath[] = [];
    for (const model of models) {
        if (model.modelName === Media.modelName || MIXED_SCAN_EXCLUDED_MODELS.has(model.modelName)) continue;
        walkSchema(model.schema, "", (path, type) => {
            if (type.instance === "Mixed" || (type.instance === "Array" && (type as any).caster?.instance === "Mixed")) {
                found.push({model, path});
            }
        });
    }
    return found;
}

async function registeredModels(): Promise<Model<any>[]> {
    // Imports every enabled module's models so their schemas are registered.
    await getAllModels();
    return mongoose.modelNames().map((name) => mongoose.model(name));
}

const hasCompany = (model: Model<any>) => !!model.schema.path("company");

/** Ids among `ids` that any record references. Raw collection queries, so soft-deleted records count. */
async function findReferencedIds(
    ids: ObjectId[],
    companyId: ObjectId,
    referencePaths: ModelPath[],
    mixedPaths: ModelPath[],
): Promise<Set<string>> {
    const referenced = new Set<string>();
    const pending = () => ids.filter((id) => !referenced.has(id.toString()));

    for (const {model, path} of referencePaths) {
        const open = pending();
        if (open.length === 0) return referenced;
        // Ids written around mongoose may be stored as strings.
        const candidates = [...open, ...open.map((id) => id.toString())];
        const values: unknown[] = await model.collection.distinct(path, {[path]: {$in: candidates}});
        values.forEach((value) => referenced.add(String(value)));
    }

    for (const {model, path} of mixedPaths) {
        const open = pending();
        if (open.length === 0) return referenced;
        const filter = {[path]: {$exists: true, $ne: null}, ...(hasCompany(model) ? {company: companyId} : {})};
        const cursor = model.collection.find(filter, {projection: {[path]: 1}});
        for await (const doc of cursor) {
            const text = JSON.stringify(doc);
            open.forEach((id) => {
                if (text.includes(id.toString())) referenced.add(id.toString());
            });
            if (open.every((id) => referenced.has(id.toString()))) break;
        }
        await cursor.close();
    }

    return referenced;
}

/** Sweeps one company's pending uploads older than the grace window. */
export async function runOrphanUploadCleanup(
    companyId: ObjectId,
    parentLogger?: serverLogger,
    options: OrphanUploadCleanupOptions = {},
): Promise<OrphanUploadCleanupResult> {
    const logger = getLogger("orphan_upload_cleanup", parentLogger);
    const graceHours = options.graceHours ?? ORPHAN_UPLOAD_GRACE_HOURS;
    const cutoff = new Date((options.now ?? new Date()).getTime() - graceHours * 60 * 60 * 1000);
    logger.start(`Sweeping uploads of company ${companyId} pending since before ${cutoff.toISOString()}...`);

    const models = options.models ?? await registeredModels();
    const referencePaths = findMediaReferencePaths(models);
    const mixedPaths = findMixedContentPaths(models);
    const gridfs = options.deleteFile ? null : getGridFSStorage("en-US", "media", logger);
    const deleteFile = options.deleteFile ?? ((fileId: string) => gridfs!.deleteFile(fileId));

    const result: OrphanUploadCleanupResult = {examined: 0, claimed: 0, deleted: 0, failed: 0};
    // Ids that failed to delete are skipped for the rest of this run.
    const skip: ObjectId[] = [];

    for (let batch = 0; batch < MAX_BATCHES_PER_RUN && !options.signal?.aborted; batch++) {
        const candidates = await Media.collection
            .find(
                {company: companyId, pendingReference: true, createdAt: {$lt: cutoff}, _id: {$nin: skip}},
                {projection: {_id: 1, fileId: 1}},
            )
            .sort({createdAt: 1})
            .limit(BATCH_SIZE)
            .toArray();
        if (candidates.length === 0) break;
        result.examined += candidates.length;

        const ids = candidates.map((media) => media._id as ObjectId);
        const referenced = await findReferencedIds(ids, companyId, referencePaths, mixedPaths);

        const claimed = ids.filter((id) => referenced.has(id.toString()));
        if (claimed.length > 0) {
            await Media.collection.updateMany({_id: {$in: claimed}}, {$unset: {pendingReference: ""}});
            result.claimed += claimed.length;
        }

        for (const media of candidates) {
            const id = media._id as ObjectId;
            if (referenced.has(id.toString())) continue;
            try {
                // The flag in the filter keeps a document that got claimed meanwhile.
                const {deletedCount} = await Media.collection.deleteOne({_id: id, pendingReference: true});
                if (deletedCount === 0) continue;
                if (media.fileId) {
                    await deleteFile(media.fileId.toString()).catch((error: unknown) => {
                        // The Media document is gone either way; a missing file needs no retry.
                        logger.warn(`Media ${id} deleted, but its GridFS file ${media.fileId} was not: ${error}`);
                    });
                }
                result.deleted += 1;
            } catch (error: unknown) {
                logger.err(`Failed to delete orphaned media ${id}: ${error}`);
                skip.push(id);
                result.failed += 1;
            }
        }

        if (candidates.length < BATCH_SIZE) break;
    }

    logger.finish(
        `Examined ${result.examined} pending upload(s): ${result.claimed} in use, ${result.deleted} deleted, ${result.failed} failed`,
    );
    return result;
}
