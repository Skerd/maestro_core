import type {Model, Types} from "mongoose";
import SchemaGuard from "@coreModule/database/security/schemaGuard";
import {COLLECTED_DATA} from "@coreModule/database/collections";
import type {UserContext} from "@coreModule/utilities/types/types";

/**
 * Display labels for ObjectId references inside audit diffs, so the activity panel can show
 * "Tower A" instead of `…9f3c2a1b`.
 *
 * Only top-level ref paths (`project`, `constructors[]`) are resolved. A label is returned only
 * when the account may read the label field on the referenced model, and only for documents of
 * the caller's company when that model is company-scoped.
 */

/** Tried in order; `name` + `surname` are joined (users, contacts). */
const LABEL_FIELDS = ["name", "surname", "title", "unitNumber", "label", "abbreviation", "symbol", "code", "reference", "email", "originalName"] as const;

const MAX_IDS_PER_MODEL = 200;
const OBJECT_ID_HEX = /^[a-f0-9]{24}$/i;

/** The model a top-level path references (`ref` on an ObjectId or an ObjectId array), if any. */
export function referencedModelName(model: Model<any>, field: string): string | undefined {
    const path = model.schema.path(field) as any;
    if (!path) return undefined;
    const ref = path.instance === "ObjectID" ? path.options?.ref : path.caster?.instance === "ObjectID" ? path.caster.options?.ref : undefined;
    return typeof ref === "string" ? ref : undefined;
}

/** Every ObjectId hex string in a diff value (id, `{_id}`, or arrays of either). */
export function collectObjectIds(value: unknown, out: Set<string> = new Set()): Set<string> {
    if (value == null) return out;
    if (Array.isArray(value)) {
        for (const item of value) collectObjectIds(item, out);
        return out;
    }
    if (typeof value === "string") {
        if (OBJECT_ID_HEX.test(value)) out.add(value.toLowerCase());
        return out;
    }
    if (typeof value === "object") {
        const maybeId = value as {toHexString?: () => string; _bsontype?: string; _id?: unknown};
        if (typeof maybeId.toHexString === "function") {
            out.add(maybeId.toHexString().toLowerCase());
        } else if (maybeId._id != null) {
            collectObjectIds(maybeId._id, out);
        }
    }
    return out;
}

function labelOf(doc: Record<string, unknown>, fields: string[]): string | null {
    const text = (f: string) => {
        const v = doc[f];
        return typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
    };
    if (fields.includes("name") && fields.includes("surname")) {
        const full = [text("name"), text("surname")].filter(Boolean).join(" ");
        if (full) return full;
    }
    for (const f of fields) {
        const v = text(f);
        if (v) return v;
    }
    return null;
}

type ResolveArgs = {
    /** Model whose audit rows are being shown. */
    model: Model<any>;
    /** Diff values by top-level field. */
    valuesByField: Map<string, unknown[]>;
    companyId: Types.ObjectId | string;
    userCtx: UserContext;
    languageCode: string;
};

export async function resolveAuditReferenceLabels({
    model,
    valuesByField,
    companyId,
    userCtx,
    languageCode,
}: ResolveArgs): Promise<Record<string, string>> {
    const idsByRef = new Map<string, Set<string>>();
    for (const [field, values] of valuesByField) {
        const ref = referencedModelName(model, field);
        if (!ref) continue;
        const ids = idsByRef.get(ref) ?? new Set<string>();
        for (const v of values) collectObjectIds(v, ids);
        if (ids.size > 0) idsByRef.set(ref, ids);
    }

    const labels: Record<string, string> = {};
    await Promise.all(
        [...idsByRef].map(async ([refName, ids]) => {
            const refModel = model.db.models[refName] as Model<any> | undefined;
            const collected = refModel && COLLECTED_DATA[refModel.collection.name];
            if (!refModel || !collected?.readFields) return;

            const readable = SchemaGuard.sanitizeFields(refModel, collected.readFields, "read", userCtx, languageCode);
            const fields = LABEL_FIELDS.filter((f) => Object.prototype.hasOwnProperty.call(readable, f));
            if (fields.length === 0) return;

            const filter: Record<string, unknown> = {_id: {$in: [...ids].slice(0, MAX_IDS_PER_MODEL)}};
            if (refModel.schema.path("company")) filter.company = companyId;

            let query = refModel.find(filter).select(fields.join(" "));
            const withDeleted = (query as {withDeleted?: () => typeof query}).withDeleted;
            if (typeof withDeleted === "function") query = withDeleted.call(query);

            for (const doc of await query.lean<Record<string, unknown>[]>()) {
                const label = labelOf(doc, fields);
                if (label) labels[String(doc._id)] = label;
            }
        }),
    );
    return labels;
}
