import {ObjectId} from "mongodb";
import type {FieldDef, SchemaDef} from "armonia/src/modules/core/helpers/schemaDefBuilder";

/**
 * Per-field value transformer. Keys use dot-notation for nested fields (e.g. "address.country").
 * Called only for non-null, non-undefined values — null/undefined are handled before reaching transforms.
 */
export type SchemaDefTransformMap = Record<string, (value: unknown) => unknown>;

// ── Shared value transformer ───────────────────────────────────────────────────

function applyFieldTransform(
    fullKey: string,
    fieldDef: FieldDef,
    value: unknown,
    transforms: SchemaDefTransformMap,
    recurseEmbedded: (items: SchemaDef, value: Record<string, any>, fullKey: string) => Record<string, any>,
): unknown {
    if (transforms[fullKey]) return transforms[fullKey](value);

    switch (fieldDef.type) {
        case "string":
        case "number":
        case "enum":
            return value;

        case "boolean":
            if (typeof value === "string") return value === "true";
            return value;

        case "stringArray":
            if (typeof value === "string") {
                try { return JSON.parse(value); } catch { return []; }
            }
            return Array.isArray(value) ? value : [];

        case "objectIdArray":
            if (typeof value === "string") {
                try {
                    const parsed = JSON.parse(value);
                    return (Array.isArray(parsed) ? parsed : [parsed]).map((id: string) => new ObjectId(id));
                } catch { return []; }
            }
            return (Array.isArray(value) ? value : [value]).map((id: string) => new ObjectId(id));

        case "objectId":
            return new ObjectId(String(value));

        case "mediaId":
            return new ObjectId(String(Array.isArray(value) ? (value as string[])[0] : value));

        case "mediaIdArray":
            return (Array.isArray(value) ? value : value ? [value] : []).map((id: string) => new ObjectId(id));

        case "date":
            return new Date(value as string);

        case "embedded":
            return recurseEmbedded(fieldDef.items, value as Record<string, any>, fullKey);

        case "embeddedArray":
            return Array.isArray(value)
                ? value.map((item: any) => recurseEmbedded(fieldDef.items, item, fullKey))
                : [];
    }
}

// ── buildCreateDataFromSchemaDef ──────────────────────────────────────────────

/**
 * Builds a `buildCreateData` function from a SchemaDef.
 *
 * Iterates SchemaDef fields, applies type-based transformations, and skips
 * undefined/null values (null on create = field not provided).
 *
 * Pass `transforms` to override any field (e.g. number fields stored as Decimal128):
 *   buildCreateDataFromSchemaDef(MySchemaDef, {
 *     price: (v) => Decimal128.fromString(String(v)),
 *   })
 */
export function buildCreateDataFromSchemaDef(
    schemaDef: SchemaDef,
    transforms: SchemaDefTransformMap = {},
) {
    return (params: Record<string, any>): Record<string, any> => {
        return buildCreateRecursive(schemaDef, params, transforms, "");
    };
}

function buildCreateRecursive(
    schemaDef: SchemaDef,
    params: Record<string, any>,
    transforms: SchemaDefTransformMap,
    prefix: string,
): Record<string, any> {
    const data: Record<string, any> = {};

    for (const [key, fieldDef] of Object.entries(schemaDef)) {
        const value = params[key];
        if (value === undefined || value === null) continue;

        const fullKey = prefix ? `${prefix}.${key}` : key;
        data[key] = applyFieldTransform(
            fullKey, fieldDef, value, transforms,
            (items, val, fk) => buildCreateRecursive(items, val, transforms, fk),
        );
    }

    return data;
}

// ── buildUpdateDataFromSchemaDef ──────────────────────────────────────────────

/**
 * Builds a `buildUpdateData` function from a SchemaDef.
 *
 * Respects write permissions, implements the null-sentinel contract:
 *   undefined  → field absent / no permission → skipped
 *   null       → user cleared the field       → passed through (factory turns it into $unset)
 *   value      → normal update                → transformed and $set
 *
 * Pass `transforms` to override any field (e.g. number fields stored as Decimal128):
 *   buildUpdateDataFromSchemaDef(MySchemaDef, {
 *     price: (v) => Decimal128.fromString(String(v)),
 *   })
 */
export function buildUpdateDataFromSchemaDef(
    schemaDef: SchemaDef,
    transforms: SchemaDefTransformMap = {},
) {
    return (params: Record<string, any>, writeFields: Record<string, any>): Record<string, any> => {
        return buildUpdateRecursive(schemaDef, params, writeFields, transforms, "");
    };
}

function buildUpdateRecursive(
    schemaDef: SchemaDef,
    params: Record<string, any>,
    writeFields: Record<string, any>,
    transforms: SchemaDefTransformMap,
    prefix: string,
): Record<string, any> {
    const update: Record<string, any> = {};

    for (const [key, fieldDef] of Object.entries(schemaDef)) {
        const value = params[key];
        if (value === undefined) continue;
        if (!writeFields[key]) continue;

        const fullKey = prefix ? `${prefix}.${key}` : key;

        if (value === null) {
            update[key] = null;
            continue;
        }

        const subPerms = typeof writeFields[key] === "object" && writeFields[key] !== null
            ? (writeFields[key] as any).keys ?? {}
            : {};

        update[key] = applyFieldTransform(
            fullKey, fieldDef, value, transforms,
            (items, val, fk) => buildUpdateRecursive(items, val, subPerms, transforms, fk),
        );
    }

    return update;
}
