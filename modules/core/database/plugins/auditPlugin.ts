import {Model, Schema, Types} from "mongoose";
import AuditLog, {AuditAction, AuditDiffEntry} from "@coreModule/database/schemas/auditLog/auditLog";
import {ObjectId} from "mongodb";

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

export const auditPlugin = (schema: Schema): void => {
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
            await AuditLog.create({
                documentId: doc._id as Types.ObjectId,
                collectionName: doc.collection.name,
                organizationId: doc.organizationId,
                actorId: doc.$locals?.auditUserId,
                action: auditAction,
                diff: auditDiff,
                //TODO - fix this, not correct for production
                company: doc.company ?? new ObjectId("000000000000000000000000")
            });
        } catch (err) {
            // Auditing should never block the main operation
            console.error("Failed to write audit log", err);
        }
    });
};

export default auditPlugin;
