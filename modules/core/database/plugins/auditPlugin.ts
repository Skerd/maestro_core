import {ClientSession, Model, Query, Schema, Types} from "mongoose";
import AuditLog, {AuditAction, AuditDiffEntry} from "@coreModule/database/schemas/auditLog/auditLog";
import {ObjectId} from "mongodb";
import {getLogger} from "@coreModule/loggers/serverLog";
import {requestContext} from "@coreModule/utilities/endpoints/requestContext";
import {withTenant} from "@coreModule/utilities/endpoints/tenantScope";
import {sensitivePaths, type Sensitivity} from "@coreModule/utilities/security/sensitiveFields";

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
    const companyId = current.company ?? previous?.company;
    if (!companyId) {
        auditLogger.warn(`Skipping audit log for ${model.collection.name} ${current._id}: no company on document`);
        return;
    }
    // An entry belongs to the audited record's company, which is not the request's when the record is
    // shared, e.g. a company edited by its parent (D16).
    await withTenant(companyId, () => AuditLog.create([{
        documentId: current._id as Types.ObjectId,
        collectionName: model.collection.name,
        organizationId: current.organizationId,
        actorId,
        action: "UPDATE" as AuditAction,
        diff,
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
        const companyId = doc.company?._id ?? doc.company ?? store.tenantCompanyId;
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

export const auditPlugin = (schema: Schema): void => {
    auditedSchemas.add(schema);
    schema.set("timestamps", true);

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
            const companyId = doc.company ?? (orgId ? new ObjectId(orgId) : null);
            if (!companyId) {
                auditLogger.warn(
                    `Skipping audit log for ${doc.collection?.name} ${doc._id}: no company on document`,
                );
                return;
            }
            await withTenant(companyId, () => AuditLog.create({
                documentId: doc._id as Types.ObjectId,
                collectionName: doc.collection.name,
                organizationId: doc.organizationId,
                actorId: doc.$locals?.auditUserId,
                action: auditAction,
                diff: auditDiff,
                company: companyId,
            }));
        } catch (err) {
            auditLogger.err(
                `Failed to write audit log: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    });
};

export default auditPlugin;
