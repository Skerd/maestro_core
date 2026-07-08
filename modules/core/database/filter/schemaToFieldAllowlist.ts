/**
 * Generates UnSanitizedFields (field allowlist) from a Mongoose schema.
 *
 * Type/operators are derived by schemaToFilterFields from the schema; this module only
 * controls which paths are in scope for SchemaGuard.sanitizeFields.
 */

import mongoose, {Schema, SchemaType} from "mongoose";
import {UnSanitizedFields} from "armonia/src/modules/core/types";

function getModelByRefName(refName: string): mongoose.Model<any> | null {
    try {
        const modelNames = mongoose.modelNames();
        const matchingName = modelNames.find(
            (n) => n.toLowerCase() === refName.toLowerCase()
        );
        return matchingName ? mongoose.model(matchingName) : null;
    } catch {
        return null;
    }
}

function resolveNestedSchema(schemaType: SchemaType): Schema | null {
    const ref =
        (schemaType as any).options?.ref ??
        (schemaType as any)?.caster?.options?.ref;
    if (ref) {
        return getModelByRefName(ref)?.schema ?? null;
    }
    return (schemaType as any).schema ?? (schemaType as any)?.caster?.schema ?? null;
}

function hasNestedSchema(schemaType: SchemaType): boolean {
    return resolveNestedSchema(schemaType) != null;
}

function isRef(schemaType: SchemaType): boolean {
    return (
        Boolean((schemaType as any).options?.ref) ||
        Boolean((schemaType as any)?.caster?.options?.ref)
    );
}

type PermissionScope = { self?: { read?: string; write?: string }; others?: { read?: string; write?: string } };

/** True if the field has read: "no-permission" for both self and others – never readable. */
function isNeverReadable(schemaType: SchemaType): boolean {
    const perms = (schemaType as any).options?.permissions as PermissionScope | undefined;
    if (!perms) return false;
    const selfRead = perms.self?.read;
    const othersRead = perms.others?.read;
    return selfRead === "no-permission" && othersRead === "no-permission";
}

/** True if the field has write: "no-permission" for both self and others – never writable. */
function isNeverWritable(schemaType: SchemaType): boolean {
    const perms = (schemaType as any).options?.permissions as PermissionScope | undefined;
    if (!perms) return false;
    const selfWrite = perms.self?.write;
    const othersWrite = perms.others?.write;
    return selfWrite === "no-permission" && othersWrite === "no-permission";
}

/**
 * Filters refAllowlist against schema-derived allowlist.
 * Only keys that exist in schemaAllowlist are kept; invalid keys are dropped.
 * Structure for valid keys comes from refAllowlist (supports nested recursion).
 */
function intersectRefAllowlistWithSchema(
    schemaAllowlist: UnSanitizedFields,
    refAllowlist: UnSanitizedFields
): UnSanitizedFields {
    const refKeys = refAllowlist.keys ?? refAllowlist;
    const result: UnSanitizedFields = {};

    for (const key of Object.keys(refKeys)) {
        if (!(key in schemaAllowlist)) continue;

        const schemaEntry = schemaAllowlist[key];
        const refEntry = refKeys[key];
        const schemaNested = schemaEntry?.keys;
        const refNested = (refEntry as { keys?: UnSanitizedFields })?.keys;

        if (schemaNested && refNested && Object.keys(refNested).length > 0) {
            const nested = intersectRefAllowlistWithSchema(schemaNested, refNested);
            if (Object.keys(nested).length > 0) {
                result[key] = { keys: nested };
            } else {
                result[key] = {};
            }
        } else if (!schemaNested) {
            result[key] = {};
        } else {
            result[key] = refEntry ?? {};
        }
    }

    return result;
}

export interface SchemaToFieldAllowlistOptions {
    /** Permission type: "read" excludes never-readable fields, "write" excludes never-writable fields. Default "read". */
    permission?: "read" | "write";
    /** Paths to exclude (e.g. password, mfaSecret). Supports dot-notation for nested paths. */
    excludePaths?: Set<string> | string[];
    /** Max depth to recurse. Default 5. Prevents runaway on cyclical refs. */
    maxDepth?: number;

    noRefffffs?: boolean
}

/**
 * Recursively builds UnSanitizedFields from a schema.
 */
function buildAllowlist(schema: Schema, options: SchemaToFieldAllowlistOptions, depth: number): UnSanitizedFields {
    const excludeSet = options.excludePaths instanceof Set ? options.excludePaths : new Set(options.excludePaths ?? []);
    const maxDepth = options.maxDepth ?? 5;

    if (depth >= maxDepth){
        return {};
    }

    const result: UnSanitizedFields = {};

    const isExcludedByPermission = (options.permission ?? "read") === "write" ? isNeverWritable : isNeverReadable;

    schema.eachPath((path, schemaType) => {
        if (path === "_id" || path === "__v" || excludeSet.has(path)) return;

        if( path === "pinned" ){
            let a = 5;
        }

        if (isExcludedByPermission(schemaType)) return;

        const schemaRefAllowlist = (schemaType as any).options?.refAllowlist as UnSanitizedFields | undefined;
        if( path === "roles" && schemaRefAllowlist){
            let a = 5;
        }
        if (schemaRefAllowlist !== undefined && options.permission !== "write") {
            const nestedSchema = resolveNestedSchema(schemaType);
            if (nestedSchema) {
                const nestedExclude = Array.from(excludeSet)
                    .filter((p) => p.startsWith(`${path}.`))
                    .map((p) => p.slice(path.length + 1));
                const schemaAllowlist = buildAllowlist(nestedSchema, {...options, excludePaths: nestedExclude,}, depth + 1);
                const filtered = intersectRefAllowlistWithSchema(schemaAllowlist, schemaRefAllowlist);
                if (Object.keys(filtered).length > 0) {
                    result[path] = { keys: filtered };
                }
            } else {
                result[path] = schemaRefAllowlist;
            }
            return;
        }

        if (hasNestedSchema(schemaType) && !( options.permission === "write" && isRef(schemaType)  )) {
            const nestedSchema = resolveNestedSchema(schemaType);
            if (!nestedSchema) return;

            const nestedExclude = Array.from(excludeSet).filter((p) => p.startsWith(`${path}.`)).map((p) => p.slice(path.length + 1));

            const nested = buildAllowlist(nestedSchema, { ...options, excludePaths: nestedExclude }, depth + 1);

            if (Object.keys(nested).length > 0) {
                result[path] = { keys: nested };
            }
            else{
                result[path] = {}
            }
        } else {
            result[path] = {};
        }
    });

    return result;
}

/**
 * Generates UnSanitizedFields from a Mongoose schema.
 *
 * @param schema - Mongoose schema (e.g. User.schema)
 * @param options - permission, excludePaths, maxDepth
 * @returns UnSanitizedFields suitable for SchemaGuard.sanitizeFields and buildFilterFieldsFromSchema
 *
 * @example
 * // Read allowlist (default) – excludes never-readable fields
 * const UserAllowedFields = schemaToFieldAllowlist(User.schema);
 *
 * @example
 * // Write allowlist – excludes never-writable fields
 * const UserAllowedWriteFields = schemaToFieldAllowlist(User.schema, { permission: "write" });
 */
export function schemaToFieldAllowlist(schema: Schema, options: SchemaToFieldAllowlistOptions = {}): UnSanitizedFields {
    return buildAllowlist(schema, options, 0);
}
