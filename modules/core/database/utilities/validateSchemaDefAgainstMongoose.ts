import {Schema} from "mongoose";
import type {SchemaDef} from "armonia/src/modules/core/helpers/schemaDefBuilder";

// Fields added by plugins or Mongoose internals — never part of a SchemaDef.
const EXCLUDED_PATHS = new Set([
    "_id", "__v", "id",
    "createdBy", "company",       // ownershipPlugin
    "deletedAt", "deletedBy",     // softDeletePlugin
    "createdAt", "updatedAt",     // timestamps / auditPlugin
]);

// Maps SchemaDef type → accepted Mongoose instance names (for type-compatibility check).
// objectIdArray and stringArray both live in Mongoose as "Array"; embeddedArray is handled separately.
// number accepts "Decimal128" because Decimal128 fields are semantically numbers in form validation.
const DEF_TYPE_TO_MONGOOSE_INSTANCE: Record<string, string[]> = {
    string:        ["String"],
    number:        ["Number", "Decimal128"],
    boolean:       ["Boolean"],
    objectId:      ["ObjectID"],
    date:          ["Date"],
    enum:          ["String"],
    objectIdArray: ["Array"],
    stringArray:   ["Array"],
    mediaId:       ["ObjectID"],
    mediaIdArray:  ["Array"],
};

/**
 * Asserts that a SchemaDef matches the Mongoose schema it describes.
 * Throws at module load time if any of the following is detected:
 *
 * 1. A SchemaDef field does not exist in the Mongoose schema (stale def)
 * 2. A SchemaDef type is incompatible with the Mongoose path instance
 * 3. A SchemaDef min/max constraint disagrees with the Mongoose minlength/maxlength or min/max option
 * 4. A Mongoose field marked `required: true` is absent from the SchemaDef
 *    (the form would silently skip validating a required DB field)
 *
 * What is intentionally NOT checked:
 * - Optional Mongoose fields absent from the SchemaDef (server-side / computed fields are allowed)
 * - `required` direction from SchemaDef → Mongoose (forms may be stricter than the DB)
 *
 * @param schema     - The Mongoose Schema instance (after all plugins are applied)
 * @param def        - The SchemaDef from armonia
 * @param entityName - Human-readable name used in error messages (e.g. "Country")
 *
 * @example
 * validateSchemaDefAgainstMongoose(CountrySchema, CountrySchemaDef, "Country");
 */
export function validateSchemaDefAgainstMongoose(
    schema: Schema,
    def: SchemaDef,
    entityName: string,
    /** Extra paths to exclude beyond the built-in plugin/system paths (e.g. system fields with no-permission). */
    excludePaths: string[] = [],
): void {
    const errors: string[] = [];
    const allExcluded = excludePaths.length > 0
        ? new Set([...EXCLUDED_PATHS, ...excludePaths])
        : EXCLUDED_PATHS;

    // Collect all top-level, non-excluded Mongoose paths and their schema types.
    const mongoosePaths: Record<string, any> = {};
    schema.eachPath((pathName, schemaType) => {
        if (!allExcluded.has(pathName) && !pathName.includes(".")) {
            mongoosePaths[pathName] = schemaType;
        }
    });

    // ── Check 1: every SchemaDef field must exist in the Mongoose schema ────────
    for (const key of Object.keys(def)) {
        if (!(key in mongoosePaths)) {
            errors.push(`"${key}" is in SchemaDef but does not exist in the Mongoose schema — remove it from the def or add the field to the schema`);
        }
    }

    // ── Check 2: required Mongoose fields must be present in SchemaDef ──────────
    // An optional Mongoose field may be intentionally absent (server-side / computed).
    // A required one being absent means the form will never validate it — that is a bug.
    for (const [pathName, mongoosePath] of Object.entries(mongoosePaths)) {
        if (mongoosePath.isRequired && !(pathName in def)) {
            errors.push(`"${pathName}" is required in the Mongoose schema but is missing from SchemaDef — add it to the def so the form validates it`);
        }
    }

    // ── Checks 3 & 4: type and constraint compatibility ──────────────────────────
    for (const [key, fieldDef] of Object.entries(def)) {
        const mongoosePath = mongoosePaths[key];
        if (!mongoosePath) continue; // already reported in check 1

        const mongooseInstance: string = mongoosePath.instance ?? "";

        // ── embedded: validate recursively against the sub-document schema ──────
        if (fieldDef.type === "embedded") {
            if (mongooseInstance !== "Embedded" && mongooseInstance !== "Mixed") {
                errors.push(
                    `"${key}" type mismatch: SchemaDef says "embedded" but Mongoose instance is "${mongooseInstance}"`
                );
            } else {
                const embeddedSchema = (mongoosePath as any).schema;
                if (embeddedSchema) {
                    try {
                        validateSchemaDefAgainstMongoose(embeddedSchema, fieldDef.items, `${entityName}.${key}`);
                    } catch (e: any) {
                        errors.push(e.message);
                    }
                }
            }
            continue;
        }

        // ── embeddedArray: validate recursively against the embedded schema ──────
        if (fieldDef.type === "embeddedArray") {
            if (mongooseInstance !== "Array" && mongooseInstance !== "DocumentArray") {
                errors.push(
                    `"${key}" type mismatch: SchemaDef says "embeddedArray" but Mongoose instance is "${mongooseInstance}"`
                );
            } else {
                const embeddedSchema = (mongoosePath as any).schema;
                if (embeddedSchema) {
                    try {
                        validateSchemaDefAgainstMongoose(embeddedSchema, fieldDef.items, `${entityName}.${key}[]`);
                    } catch (e: any) {
                        errors.push(e.message);
                    }
                }
            }
            continue;
        }

        const expectedInstances = DEF_TYPE_TO_MONGOOSE_INSTANCE[fieldDef.type];

        // Check 3: type compatibility
        if (expectedInstances && !expectedInstances.includes(mongooseInstance)) {
            errors.push(
                `"${key}" type mismatch: SchemaDef says "${fieldDef.type}" (expects Mongoose "${expectedInstances.join(" | ")}") but Mongoose instance is "${mongooseInstance}"`
            );
            continue; // constraint checks would be meaningless on a wrong type
        }

        // Check 4: constraint compatibility — only when BOTH sides define the constraint
        const opts = mongoosePath.options ?? {};

        if (fieldDef.type === "string") {
            const mongooseMin: number | undefined = typeof opts.minlength === "number" ? opts.minlength : undefined;
            const mongooseMax: number | undefined = typeof opts.maxlength === "number" ? opts.maxlength : undefined;

            if (fieldDef.min !== undefined && mongooseMin !== undefined && fieldDef.min !== mongooseMin) {
                errors.push(
                    `"${key}" min mismatch: SchemaDef min=${fieldDef.min} but Mongoose minlength=${mongooseMin}`
                );
            }
            if (fieldDef.max !== undefined && mongooseMax !== undefined && fieldDef.max !== mongooseMax) {
                errors.push(
                    `"${key}" max mismatch: SchemaDef max=${fieldDef.max} but Mongoose maxlength=${mongooseMax}`
                );
            }
        }

        if (fieldDef.type === "number") {
            const mongooseMin: number | undefined = typeof opts.min === "number" ? opts.min : undefined;
            const mongooseMax: number | undefined = typeof opts.max === "number" ? opts.max : undefined;

            if (fieldDef.min !== undefined && mongooseMin !== undefined && fieldDef.min !== mongooseMin) {
                errors.push(
                    `"${key}" min mismatch: SchemaDef min=${fieldDef.min} but Mongoose min=${mongooseMin}`
                );
            }
            if (fieldDef.max !== undefined && mongooseMax !== undefined && fieldDef.max !== mongooseMax) {
                errors.push(
                    `"${key}" max mismatch: SchemaDef max=${fieldDef.max} but Mongoose max=${mongooseMax}`
                );
            }
        }
    }

    if (errors.length > 0) {
        throw new Error(
            `[SchemaDef] "${entityName}" definition does not match its Mongoose schema:\n` +
            errors.map((e) => `  • ${e}`).join("\n")
        );
    }
}
