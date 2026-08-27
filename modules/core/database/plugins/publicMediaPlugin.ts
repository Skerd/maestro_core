import type {Schema} from "mongoose";
import type {SchemaDef} from "armonia/src/modules/core/helpers/schemaDefBuilder";
import {collectPublicMediaIds} from "armonia/src/modules/core/helpers/collectPublicMediaIds";
import {markPublic, markPublicFromDocument, markPublicFromSchemaWrite} from "@coreModule/utilities/media/mediaAccessService";
import {ObjectId} from "mongodb";

export type PublicMediaPluginOptions = {
    schemaDef: SchemaDef | Record<string, unknown>;
    /** Company.logo: Media.company is the company document's own `_id`. */
    companyFromDocumentId?: boolean;
};

function payloadFromUpdate(update: unknown): Record<string, unknown> {
    if (!update || typeof update !== "object") {
        return {};
    }
    const rec = update as Record<string, unknown>;
    if (rec.$set && typeof rec.$set === "object") {
        return rec.$set as Record<string, unknown>;
    }
    const withoutOps: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rec)) {
        if (!key.startsWith("$")) {
            withoutOps[key] = value;
        }
    }
    return withoutOps;
}

/**
 * After a parent document is written, mark Media IDs from SchemaDef
 * `publicAccess` fields as publicly serveable.
 */
export function publicMediaPlugin(schema: Schema, options: PublicMediaPluginOptions): void {
    const schemaDef = options.schemaDef as SchemaDef;

    schema.post("save", async function (doc) {
        if (doc) {
            if (options.companyFromDocumentId) {
                const record = typeof doc.toObject === "function" ? doc.toObject() : doc;
                await markPublicFromSchemaWrite(schemaDef, record, doc._id as ObjectId);
            } else {
                await markPublicFromDocument(schemaDef, doc);
            }
        }
    });

    schema.post("findOneAndUpdate", async function (doc) {
        if (doc) {
            if (options.companyFromDocumentId) {
                const record = typeof doc.toObject === "function" ? doc.toObject() : doc;
                await markPublicFromSchemaWrite(schemaDef, record, doc._id);
            } else {
                await markPublicFromDocument(schemaDef, doc);
            }
        }
    });

    schema.post(["updateOne", "updateMany"], async function () {
        const query = this.getQuery() as Record<string, unknown>;
        const payload = payloadFromUpdate(this.getUpdate());
        const ids = collectPublicMediaIds(schemaDef, payload);
        if (ids.length === 0) {
            return;
        }
        const company = query.company;
        await markPublic(ids, company != null ? String((company as {_id?: unknown})._id ?? company) : null);
    });
}

export default publicMediaPlugin;
