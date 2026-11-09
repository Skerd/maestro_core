import {ClientSession, Model, Query, Schema, Types} from "mongoose";
import AuditLog, {AuditAction, AuditDiffEntry} from "@coreModule/database/schemas/auditLog/auditLog";
import {ObjectId} from "mongodb";
import {getLogger} from "@coreModule/loggers/serverLog";
import {requestContext} from "@coreModule/utilities/endpoints/requestContext";
import {withTenant} from "@coreModule/utilities/endpoints/tenantScope";
import {sensitivePaths, type Sensitivity} from "@coreModule/utilities/security/sensitiveFields";
import {decryptHealthFieldsOnLoad, encryptHealthDiff, encryptHealthFieldsOnSave} from "@coreModule/database/plugins/healthEncryption";

const auditLogger = getLogger("audit_plugin");

type LeanDoc = Record<string, any> | null | undefined;

const OMIT_FIELDS = new Set(["__v"]);

const toComparable = (value: unknown) => {
    if (value === undefined) return null;
    return value;
};

const buildDiff = (previous: LeanDoc, current: LeanDoc): Record<string, AuditDiffEntry> => {
    const diff: Record<string, AuditDiffEntry> = {};
    const keys = new Set<string>([
        ...Object.keys(previous || {}),
        ...Object.keys(current || {}),
    ]);

    for (const key of keys) {
        if (OMIT_FIELDS.has(key)) {
            continue;
        }
        const before = toComparable(previous ? previous[key] : null);
        const after = toComparable(current ? current[key] : null);
        const same = JSON.stringify(before) === JSON.stringify(after);
        if (!same) {
            diff[key] = {
                from: before,
                to: after,
            };
        }
    }

    return diff;
};

const auditedSchemas = new WeakSet<Schema>();

/**
 * The id of a document's company. A create often receives the request's company document, which Mongoose then holds
 * as populated: the entry must carry its id, or the tenant guard reads it as another company and refuses it (TD-B36).
 */
function companyIdOf(value: unknown): ObjectId | undefined {
    if (value instanceof ObjectId) return value;
    if (value instanceof Types.ObjectId) return new ObjectId(value.toHexString());
    if (value && typeof value === "object" && "_id" in value) return companyIdOf(value._id);
    if (typeof value === "string" && ObjectId.isValid(value)) return new ObjectId(value);
    return undefined;
}

/**
 * Audit entry for an update that bypassed `save` (operator updates in
 * `BaseCrudService.updateById`): the same UPDATE diff the save hook records,
 * written in the caller's transaction. No-op for models without this plugin.
 */
export async function auditOperatorUpdate(
    model: Model<any>,
    previous: LeanDoc,
    current: LeanDoc,
    actorId: ObjectId | undefined,
    session?: ClientSession | null,
): Promise<void> {
    if (!auditedSchemas.has(model.schema) || !current) return;
    const diff = buildDiff(previous, current);
    // `updatedAt` always moves; on its own it isn't a change worth an entry
    if (Object.keys(diff).every(key => key === "updatedAt")) return;
    const companyId = companyIdOf(current.company) ?? companyIdOf(previous?.company);
    if (!companyId) {
        auditLogger.warn(`Skipping audit log for ${model.collection.name} ${current._id}: no company on document`);
        return;
    }
    const sealedDiff = await encryptHealthDiff(model.schema, diff, {company: companyId, collection: model.collection.name, documentId: current._id});
    // An entry belongs to the audited record's company, which is not the request's when the record is
    // shared, e.g. a company edited by its parent (D16).
    await withTenant(companyId, () => AuditLog.create([{
        documentId: current._id as Types.ObjectId,
        collectionName: model.collection.name,
        organizationId: current.organizationId,
        actorId,
        action: "UPDATE" as AuditAction,
        diff: sealedDiff,
        company: companyId,
    }], {session: session ?? undefined}));
}

const sensitivePathsBySchema = new WeakMap<Schema, Map<string, Sensitivity>>();
/** Reads already recorded in a request (`record:fields`), so a record opened twice in one request is one entry. */
const recordedReadsByRequest = new WeakMap<object, Set<string>>();

function isEmptyValue(value: unknown): boolean {
    if (value == null) return true;
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === "object" && !(value instanceof Date) && !(value instanceof Types.ObjectId)) {
        return Object.keys(value as Record<string, unknown>).length === 0;
    }
    return false;
}

/**
 * Sensitive top-level fields (SEC-06) a query explicitly asked for. Only an inclusive projection counts: that is how a
 * request reads what its caller may see (SchemaGuard's select). Code that loads whole documents for its own work
 * (no projection) is not someone opening the record.
 */
function requestedSensitiveFields(query: Query<unknown, unknown>, marked: Map<string, Sensitivity>): string[] {
    const projection = query.projection() as Record<string, unknown> | undefined;
    if (!projection) return [];
    const fields = new Set<string>();
    for (const [path, include] of Object.entries(projection)) {
        if (include !== 1 && include !== true) continue;
        const top = path.split(".")[0]!;
        if (marked.has(top)) fields.add(top);
    }
    return [...fields];
}

/**
 * READ entry when a signed-in user's request loads sensitive fields (SEC-06, D56): who, which record, which fields,
 * never the values. Written outside any transaction, so a read is on record even if the request fails afterwards.
 */
async function recordSensitiveReads(query: Query<unknown, unknown>, result: unknown): Promise<void> {
    const store = requestContext.getStore();
    const actorId = store?.actionUserCtx?.userId;
    if (!store || !actorId || result == null) return;
    const model = query.model as Model<any>;
    let marked = sensitivePathsBySchema.get(model.schema);
    if (!marked) {
        marked = sensitivePaths(model.schema);
        sensitivePathsBySchema.set(model.schema, marked);
    }
    if (marked.size === 0) return;
    const requested = requestedSensitiveFields(query, marked);
    if (requested.length === 0) return;

    let recorded = recordedReadsByRequest.get(store);
    if (!recorded) {
        recorded = new Set();
        recordedReadsByRequest.set(store, recorded);
    }
    for (const doc of (Array.isArray(result) ? result : [result]) as Record<string, any>[]) {
        const fields = requested.filter((field) => !isEmptyValue(typeof doc.get === "function" ? doc.get(field) : doc[field]));
        // The selection may leave `company` out; the request's company owns what it reads.
        const companyId = companyIdOf(doc.company) ?? companyIdOf(store.tenantCompanyId);
        if (fields.length === 0 || !doc._id || !companyId) continue;
        const key = `${String(doc._id)}:${fields.join(",")}`;
        if (recorded.has(key)) continue;
        recorded.add(key);
        try {
            await withTenant(companyId, () => AuditLog.create({
                documentId: doc._id as Types.ObjectId,
                collectionName: model.collection.name,
                actorId: new ObjectId(actorId),
                action: "READ" as AuditAction,
                diff: Object.fromEntries(fields.map((field) => [field, {from: null, to: null}])),
                company: companyId,
            }));
        } catch (err) {
            auditLogger.err(`Failed to record a sensitive read: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}

/**
 * Audit trail (DB-01): a CREATE / UPDATE entry per save (operator updates call `auditOperatorUpdate`) and a READ
 * entry when a request selects sensitive fields (D56). It also turns on Mongoose `timestamps`, which stamp what
 * lifeCyclePlugin's hooks do not: `insertMany`, `bulkWrite`, replacements and an upsert's `createdAt`. Audit-exempt
 * schemas keep their own `timestamps` option.
 * Health fields are encrypted at rest here (D102): opened on load before the read audit looks at them, sealed on save
 * after the diff is taken, and sealed in the stored diff too.
 */
export const auditPlugin = (schema: Schema): void => {
    auditedSchemas.add(schema);
    schema.set("timestamps", true);
    decryptHealthFieldsOnLoad(schema);

    schema.post(["find", "findOne"], async function (this: Query<unknown, unknown>, result: unknown) {
        await recordSensitiveReads(this, result);
    });

    schema.pre("save", async function (next) {
        const doc: any = this;
        try {
            const model = doc.constructor as Model<any>;
            const current = doc.toObject({depopulate: true});

            if (doc.isNew) {
                doc.$locals.auditAction = "CREATE" as AuditAction;
                doc.$locals.auditDiff = buildDiff(null, current);
                return next();
            }

            const previous = await model.findById(doc._id).lean();
            doc.$locals.auditAction = "UPDATE" as AuditAction;
            doc.$locals.auditDiff = buildDiff(previous, current);
            return next();
        } catch (error) {
            return next(error as any);
        }
    });

    schema.post("save", async function (doc: any) {
        const auditAction: AuditAction | undefined = doc.$locals?.auditAction;
        const auditDiff: Record<string, AuditDiffEntry> | undefined = doc.$locals?.auditDiff;

        if (!auditAction || !auditDiff || Object.keys(auditDiff).length === 0) {
            return;
        }

        try {
            const orgId = requestContext.getStore()?.actionUserCtx?.orgId;
            const companyId = companyIdOf(doc.company) ?? (orgId ? new ObjectId(orgId) : null);
            if (!companyId) {
                auditLogger.warn(
                    `Skipping audit log for ${doc.collection?.name} ${doc._id}: no company on document`,
                );
                return;
            }
            const diff = await encryptHealthDiff(schema, auditDiff, {company: companyId, collection: doc.collection.name, documentId: doc._id});
            await withTenant(companyId, () => AuditLog.create({
                documentId: doc._id as Types.ObjectId,
                collectionName: doc.collection.name,
                organizationId: doc.organizationId,
                actorId: doc.$locals?.auditUserId,
                action: auditAction,
                diff,
                company: companyId,
            }));
        } catch (err) {
            auditLogger.err(
                `Failed to write audit log: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    });

    encryptHealthFieldsOnSave(schema);
};

export default auditPlugin;
