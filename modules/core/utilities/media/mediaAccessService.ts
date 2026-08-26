import {ObjectId} from "mongodb";
import type {SchemaDef} from "armonia/src/modules/core/helpers/schemaDefBuilder";
import {collectPublicMediaIds} from "armonia/src/modules/core/helpers/collectPublicMediaIds";
import Media from "@coreModule/database/schemas/media/media";

/**
 * Denormalized cache for the public media GET path.
 * Source of truth is SchemaDef `publicAccess` on the owning field.
 */
export async function markPublic(
    ids: Array<string | ObjectId>,
    companyId?: string | ObjectId | null,
): Promise<number> {
    const unique = [...new Set(ids.map((id) => String(id)).filter(Boolean))];
    if (unique.length === 0) {
        return 0;
    }
    const filter: Record<string, unknown> = {
        _id: {$in: unique.map((id) => new ObjectId(id))},
    };
    if (companyId) {
        filter.company = new ObjectId(String(companyId));
    }
    const result = await Media.updateMany(filter, {$set: {isPublic: true}});
    return result.modifiedCount ?? 0;
}

export async function markPublicFromSchemaWrite(
    schemaDef: SchemaDef,
    data: unknown,
    companyId?: string | ObjectId | null,
): Promise<number> {
    return markPublic(collectPublicMediaIds(schemaDef, data), companyId);
}

function companyIdFromDoc(doc: Record<string, unknown>): ObjectId | string | null {
    const company = doc.company as {_id?: unknown} | string | ObjectId | null | undefined;
    if (company && typeof company === "object" && "_id" in company && company._id != null) {
        return company._id as ObjectId | string;
    }
    if (company) {
        return company as ObjectId | string;
    }
    if (doc._id) {
        return doc._id as ObjectId | string;
    }
    return null;
}

export async function markPublicFromDocument(
    schemaDef: SchemaDef,
    doc: unknown,
): Promise<number> {
    if (!doc || typeof doc !== "object") {
        return 0;
    }
    const record = typeof (doc as {toObject?: () => unknown}).toObject === "function"
        ? (doc as {toObject: () => Record<string, unknown>}).toObject()
        : doc as Record<string, unknown>;
    return markPublicFromSchemaWrite(schemaDef, record, companyIdFromDoc(record));
}
