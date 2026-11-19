/**
 * `contains` on a reference (D170): "Patient contains maria" matches the rows whose linked record has "maria" in one of
 * its name fields, so a list can be searched by the names people see instead of ids. The rule is resolved to the
 * matching ids before the DSL compiles (`buildMongoQuery` is synchronous), one lookup per field and text.
 *
 * The name fields are the linked model's label fields (`REFERENCE_LABEL_FIELDS`, as the activity timeline names a linked
 * record) and the column's `refDisplayKey`, stored as text, that the caller may read on that model (SchemaGuard), never
 * a special-category field (SEC-06). A tenant-owned target is narrowed to the company by the tenant scope (D16); any
 * other target (users, platform lists) only among the ids the list's own records hold, so a word never scans every
 * company's rows. Each word must appear in one of the name fields.
 */

import type {Model, Schema} from "mongoose";
import type {ObjectId} from "mongodb";
import type {FilterGroup, FilterRule} from "armonia/src/modules/core/database/filter/filter.types";
import type {FieldRegistry} from "armonia/src/modules/core/database/filter/fieldRegistry.types";
import {collectPathsFromSanitized} from "armonia/src/modules/core/database/filter/pathUtils";
import {COLUMN_TYPE} from "armonia/src/modules/core/database/filter/typeOperators";
import type {TableColumnConfig} from "armonia/src/modules/core/api/company/private/users/tableConfig.form.response.type";
import {COLLECTED_DATA} from "@coreModule/database/collections";
import SchemaGuard from "@coreModule/database/security/schemaGuard";
import {escapeRegex} from "@coreModule/utilities/helpers";
import {isTenantOwned} from "@coreModule/database/plugins/tenantReferences";
import {REFERENCE_LABEL_FIELDS} from "@coreModule/database/schemas/auditLog/auditReferenceLabels";
import {sensitivePaths, sensitivityOfPath} from "@coreModule/utilities/security/sensitiveFields";
import type {UserContext} from "@coreModule/utilities/types/types";

/** Words past this are ignored: a search box sends a few, and each one is a regex per name field. */
const MAX_WORDS = 5;

export type ReferenceMatches = ReadonlyMap<string, ObjectId[]>;

/** One lookup per field and text: the same rule twice in a filter resolves once. */
export function referenceMatchKey(field: string, value: string): string {
    return `${field}\u0000${value.trim().toLowerCase()}`;
}

function searchWords(value: string): string[] {
    return value.trim().split(/\s+/).filter(Boolean).slice(0, MAX_WORDS);
}

function collectReferenceRules(group: FilterGroup, registry: FieldRegistry, out: FilterRule[]): FilterRule[] {
    for (const rule of group.rules) {
        if (rule.operator !== "contains" || typeof rule.value !== "string" || !rule.value.trim()) continue;
        if (registry.getField(rule.field)?.type === COLUMN_TYPE.OBJECT_ID) out.push(rule);
    }
    for (const child of group.groups) collectReferenceRules(child, registry, out);
    return out;
}

/** The target's paths the caller may read, or none when the target is not registered or nothing is readable. */
function readablePaths(target: Model<unknown>, userCtx: UserContext, languageCode: string): Set<string> {
    const readFields = COLLECTED_DATA[target.collection.name]?.readFields;
    if (!readFields) return new Set();
    try {
        return collectPathsFromSanitized(SchemaGuard.sanitizeFields(target, readFields, "read", userCtx, languageCode));
    } catch {
        // `user_permissions_not_sufficient`: the caller reads nothing of the target, so no name can match.
        return new Set();
    }
}

/** The target's readable, non-sensitive text fields that name its record. */
function nameFields(target: Model<unknown>, readable: Set<string>, displayKeys: string[] | undefined): string[] {
    const schema: Schema = target.schema;
    const marked = sensitivePaths(schema);
    const naming = new Set<string>([...REFERENCE_LABEL_FIELDS, ...(displayKeys ?? []).filter((key) => !key.startsWith("!"))]);
    return [...naming].filter((key) =>
        readable.has(key) && schema.path(key)?.instance === "String" && !sensitivityOfPath(key, marked));
}

type ResolveArgs = {
    filter: FilterGroup;
    /** The list's filter registry: the caller's readable fields only. */
    registry: FieldRegistry;
    /** The list's model. */
    model: Model<unknown>;
    /** The list's table configuration (for each column's `refDisplayKey`). */
    tableConfig: TableColumnConfig[];
    userCtx: UserContext;
    languageCode: string;
};

/** Ids matching each reference `contains` rule of `filter`, keyed by {@link referenceMatchKey}. No match is `[]`. */
export async function resolveReferenceContains(args: ResolveArgs): Promise<ReferenceMatches> {
    const pending = new Map<string, FilterRule>();
    for (const rule of collectReferenceRules(args.filter, args.registry, [])) {
        pending.set(referenceMatchKey(rule.field, String(rule.value)), rule);
    }

    const matches = new Map<string, ObjectId[]>();
    await Promise.all(
        [...pending].map(async ([key, rule]) => {
            matches.set(key, await matchingIds(rule.field, String(rule.value), args));
        }),
    );
    return matches;
}

async function matchingIds(field: string, text: string, {registry, model, tableConfig, userCtx, languageCode}: ResolveArgs): Promise<ObjectId[]> {
    const ref = registry.getField(field)?.ref;
    const target = ref ? (model.db.models[ref] as Model<unknown> | undefined) : undefined;
    if (!target) return [];

    const displayKeys = tableConfig.find((column) => column.id === field)?.meta?.refDisplayKey;
    const fields = nameFields(target, readablePaths(target, userCtx, languageCode), displayKeys);
    const words = searchWords(text);
    if (fields.length === 0 || words.length === 0) return [];

    const query: Record<string, unknown> = {
        $and: words.map((word) => ({$or: fields.map((name) => ({[name]: {$regex: escapeRegex(word), $options: "i"}}))})),
    };
    if (!isTenantOwned(target.schema)) {
        query._id = {$in: await model.distinct(field)};
    }
    const rows = await target.find(query).select("_id").lean<{_id: ObjectId}[]>();
    return rows.map((row) => row._id);
}
