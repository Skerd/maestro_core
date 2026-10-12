import {ClientSession, Model, Schema, Types} from "mongoose";
import AuditLog, {AuditAction, AuditDiffEntry} from "@coreModule/database/schemas/auditLog/auditLog";
import {ObjectId} from "mongodb";
import {getLogger} from "@coreModule/loggers/serverLog";
import {requestContext} from "@coreModule/utilities/endpoints/requestContext";

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
    await AuditLog.create([{
        documentId: current._id as Types.ObjectId,
        collectionName: model.collection.name,
        organizationId: current.organizationId,
        actorId,
        action: "UPDATE" as AuditAction,
        diff,
        company: companyId,
    }], {session: session ?? undefined});
}

export const auditPlugin = (schema: Schema): void => {
    auditedSchemas.add(schema);
    schema.set("timestamps", true);

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
            await AuditLog.create({
                documentId: doc._id as Types.ObjectId,
                collectionName: doc.collection.name,
                organizationId: doc.organizationId,
                actorId: doc.$locals?.auditUserId,
                action: auditAction,
                diff: auditDiff,
                company: companyId,
            });
        } catch (err) {
            auditLogger.err(
                `Failed to write audit log: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    });
};

export default auditPlugin;
