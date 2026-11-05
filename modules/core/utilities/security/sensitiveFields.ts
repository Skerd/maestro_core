import mongoose, {Schema, SchemaType, SchemaTypeOptions} from "mongoose";
import type {SanitizedFields} from "armonia/src/modules/core/types";

/** Special-category data kinds (SEC-06, D39). */
export type Sensitivity = NonNullable<SchemaTypeOptions<unknown>["sensitivity"]>;

/** A sub-schema under a path: single nested (`type: {…}`) or the element schema of a document array. */
function childSchema(schemaType: SchemaType): Schema | undefined {
    return (schemaType as SchemaType & {schema?: Schema}).schema;
}

/**
 * Every path of `schema` marked with `sensitivity`, as permission-tag paths (dots → underscores, the way
 * `normalizeSchemaPermissions` names them). Everything under a marked path is just as sensitive.
 */
export function sensitivePaths(schema: Schema, prefix = ""): Map<string, Sensitivity> {
    const found = new Map<string, Sensitivity>();
    schema.eachPath((pathName, schemaType) => {
        const fullPath = prefix ? `${prefix}.${pathName}` : pathName;
        const sensitivity = schemaType.options?.sensitivity;
        if (sensitivity) {
            found.set(fullPath.replace(/\./g, "_"), sensitivity);
            return;
        }
        const nested = childSchema(schemaType);
        if (nested) {
            for (const [path, kind] of sensitivePaths(nested, fullPath)) found.set(path, kind);
        }
    });
    return found;
}

/** The sensitivity of a field path (dotted or underscored), inherited from the nearest marked ancestor. */
export function sensitivityOfPath(path: string, marked: Map<string, Sensitivity>): Sensitivity | undefined {
    const normalized = path.replace(/\./g, "_");
    for (const [markedPath, kind] of marked) {
        if (normalized === markedPath || normalized.startsWith(`${markedPath}_`)) return kind;
    }
    return undefined;
}

/**
 * Snippet keys that expose a sensitive field of the referenced model (SEC-06: never in a snippet), as
 * `Model.path → RefModel.field`. Checked over every registered model when permissions are synced at start-up.
 */
export function findSensitiveSnippetFields(connection: typeof mongoose = mongoose): string[] {
    const leaks: string[] = [];
    for (const modelName of connection.modelNames()) {
        connection.model(modelName).schema.eachPath((pathName, schemaType) => {
            const options = schemaType.options ?? {};
            const casterOptions = (schemaType as SchemaType & {caster?: SchemaType}).caster?.options ?? {};
            const ref = options.ref ?? casterOptions.ref;
            const keys = (options.refAllowlist ?? casterOptions.refAllowlist)?.keys;
            if (typeof ref !== "string" || !keys) return;
            const refName = connection.modelNames().find((name) => name.toLowerCase() === ref.toLowerCase());
            if (!refName) return;
            const marked = sensitivePaths(connection.model(refName).schema);
            for (const key of Object.keys(keys)) {
                if (sensitivityOfPath(key, marked)) leaks.push(`${modelName}.${pathName} → ${refName}.${key}`);
            }
        });
    }
    return leaks;
}

/**
 * A read selection without the schema's sensitive fields (SEC-06), for list reads: a list carries every row, so its
 * rows never hold special-category data; a record's sheet loads those fields with its own single read. Keeps `_id`
 * when nothing else is left, because an empty selection loads whole documents.
 */
export function withoutSensitiveFields(fields: SanitizedFields, schema: Schema): SanitizedFields {
    const marked = sensitivePaths(schema);
    if (marked.size === 0) return fields;
    const kept: SanitizedFields = Object.fromEntries(Object.entries(fields).filter(([field]) => !sensitivityOfPath(field, marked)));
    return Object.keys(kept).length > 0 ? kept : {_id: {}};
}
