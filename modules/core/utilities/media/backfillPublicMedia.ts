import {ObjectId} from "mongodb";
import type {Model} from "mongoose";
import type {SchemaDef} from "armonia/src/modules/core/helpers/schemaDefBuilder";
import {collectPublicMediaIds} from "armonia/src/modules/core/helpers/collectPublicMediaIds";
import {markPublic} from "@coreModule/utilities/media/mediaAccessService";
import type {serverLogger} from "@coreModule/loggers/serverLog";
import {ProjectSchemaDef} from "armonia/src/modules/propertyManagement/api/realEstate/private/project/project.schema-def";
import {EdificeSchemaDef} from "armonia/src/modules/propertyManagement/api/realEstate/private/edifice/edifice.schema-def";
import {FloorSchemaDef} from "armonia/src/modules/propertyManagement/api/realEstate/private/floor/floor.schema-def";
import {UnitSchemaDef} from "armonia/src/modules/propertyManagement/api/realEstate/private/unit/unit/unit.schema-def";
import {StorySchemaDef} from "armonia/src/modules/propertyManagement/api/realEstate/private/story/story.schema-def";
import {ProductSchemaDef} from "armonia/src/modules/eCommerce/api/eCommerce/private/product/product.schema-def";
import {ProductVariantSchemaDef} from "armonia/src/modules/eCommerce/api/eCommerce/private/productVariant/productVariant.schema-def";
import {CollectionSchemaDef} from "armonia/src/modules/eCommerce/api/eCommerce/private/collection/collection.schema-def";
import {ListingSchemaDef} from "armonia/src/modules/eCommerceMarketplace/api/eCommerceMarketplace/private/listing/listing.schema-def";
import {TaskRequestSchemaDef} from "armonia/src/modules/eCommerceMarketplace/api/eCommerceMarketplace/private/taskRequest/taskRequest.schema-def";
import {CompanySchemaDef} from "armonia/src/modules/core/api/company/private/company/company.schema-def";

type BackfillSource = {
    name: string;
    schemaDef: SchemaDef | Record<string, unknown>;
    loadModel: () => Promise<Model<any>>;
    companyFromDocumentId?: boolean;
};

const SOURCES: BackfillSource[] = [
    {name: "Project", schemaDef: ProjectSchemaDef, loadModel: () => import("@propertyManagement/database/schemas/project/project").then((m) => m.default)},
    {name: "Edifice", schemaDef: EdificeSchemaDef, loadModel: () => import("@propertyManagement/database/schemas/edifice/edifice").then((m) => m.default)},
    {name: "Floor", schemaDef: FloorSchemaDef, loadModel: () => import("@propertyManagement/database/schemas/floor/floor").then((m) => m.default)},
    {name: "Unit", schemaDef: UnitSchemaDef, loadModel: () => import("@propertyManagement/database/schemas/unit/unit").then((m) => m.default)},
    {name: "Story", schemaDef: StorySchemaDef, loadModel: () => import("@propertyManagement/database/schemas/story/story").then((m) => m.default)},
    {name: "Product", schemaDef: ProductSchemaDef, loadModel: () => import("@eCommerceModule/database/schemas/product/product").then((m) => m.default)},
    {name: "ProductVariant", schemaDef: ProductVariantSchemaDef, loadModel: () => import("@eCommerceModule/database/schemas/productVariant/productVariant").then((m) => m.default)},
    {name: "ProductCollection", schemaDef: CollectionSchemaDef, loadModel: () => import("@eCommerceModule/database/schemas/collection/collection").then((m) => m.default)},
    {name: "Listing", schemaDef: ListingSchemaDef, loadModel: () => import("@eCommerceMarketplaceModule/database/schemas/listing/listing").then((m) => m.default)},
    {name: "TaskRequest", schemaDef: TaskRequestSchemaDef, loadModel: () => import("@eCommerceMarketplaceModule/database/schemas/taskRequest/taskRequest").then((m) => m.default)},
    {name: "Company", schemaDef: CompanySchemaDef, loadModel: () => import("@coreModule/database/schemas/company/company").then((m) => m.default), companyFromDocumentId: true},
];

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
 */
export async function backfillPublicMedia(logger: serverLogger): Promise<void> {
    logger.start("Backfilling public media flags from SchemaDef...");
    let total = 0;
    for (const source of SOURCES) {
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
