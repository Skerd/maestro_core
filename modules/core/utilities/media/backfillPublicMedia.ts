import {ObjectId} from "mongodb";
import type {SchemaDef} from "armonia/src/modules/core/helpers/schemaDefBuilder";
import {collectPublicMediaIds} from "armonia/src/modules/core/helpers/collectPublicMediaIds";
import {markPublic} from "@coreModule/utilities/media/mediaAccessService";
import type {serverLogger} from "@coreModule/loggers/serverLog";
import {CompanySchemaDef} from "armonia/src/modules/core/api/company/private/company/company.schema-def";
import {
    getPublicMediaBackfillSources,
    registerPublicMediaBackfillSource,
} from "@coreModule/utilities/media/publicMediaBackfillRegistry";
import {loadOptionalModuleBootstraps} from "@initializer";

registerPublicMediaBackfillSource({
    name: "Company",
    schemaDef: CompanySchemaDef,
    loadModel: () => import("@coreModule/database/schemas/company/company").then((m) => m.default),
    companyFromDocumentId: true,
});

function companyIdFromDoc(doc: Record<string, unknown>, companyFromDocumentId?: boolean): ObjectId | string | null {
    if (companyFromDocumentId && doc._id) {
        return doc._id as ObjectId | string;
    }
    const company = doc.company as {_id?: unknown} | string | ObjectId | null | undefined;
    if (company && typeof company === "object" && "_id" in company && company._id != null) {
        return company._id as ObjectId | string;
    }
    return company ? (company as ObjectId | string) : null;
}

/**
 * Idempotent: marks Media.isPublic for IDs currently sitting on SchemaDef
 * publicAccess fields. Safe to run on every API boot.
 *
 * Feature SchemaDefs are contributed from moduleBootstrap via
 * {@link registerPublicMediaBackfillSource}. Core keeps Company only.
 */
export async function backfillPublicMedia(logger: serverLogger): Promise<void> {
    await loadOptionalModuleBootstraps(logger);
    logger.start("Backfilling public media flags from SchemaDef...");
    let total = 0;
    for (const source of getPublicMediaBackfillSources()) {
        const Model = await source.loadModel();
        const docs = await Model.find({}).lean();
        const byCompany = new Map<string, string[]>();
        for (const doc of docs) {
            const ids = collectPublicMediaIds(source.schemaDef as SchemaDef, doc);
            if (ids.length === 0) {
                continue;
            }
            const companyId = companyIdFromDoc(doc as Record<string, unknown>, source.companyFromDocumentId);
            const key = companyId ? String(companyId) : "";
            const bucket = byCompany.get(key) ?? [];
            bucket.push(...ids);
            byCompany.set(key, bucket);
        }
        for (const [companyKey, ids] of byCompany) {
            total += await markPublic(ids, companyKey || null);
        }
        logger.debug(`Public media backfill ${source.name}: ${docs.length} docs`);
    }
    logger.finish(`Public media backfill complete (modified ${total} media docs)`);
}
