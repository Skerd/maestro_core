import mongoose, {
    Document,
    FieldPermissions,
    Model,
    ModelPermissionAction,
    PermissionAction,
    Schema,
    SchemaType
} from "mongoose";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {CONSTANTS} from "@coreModule/environment";
import {UserContext} from "@coreModule/utilities/types/types";
import {SanitizedFields, UnSanitizedFields} from "armonia/src/modules/core/types";

type PopulateResult = {
    select: string[];
    populate: any[];
};


const hasFieldPermission = (
    fieldPermissions: FieldPermissions | undefined,
    isSelf: boolean,
    operation: "read" | "write",
    userPermissions: string[] | undefined,
    accessMode: "strict" | "loose"
): boolean => {
    if (!fieldPermissions) return false;
    const rule = accessMode === "loose" ? fieldPermissions.self : (isSelf ? fieldPermissions.self : fieldPermissions.others);
    if (!rule) return false;
    if (operation === "read" && rule.publicRead) return true;
    if (operation === "write" && rule.publicWrite) return true;
    const requiredPermission = rule[operation];
    if (!requiredPermission) return false;
    return (userPermissions || []).includes(requiredPermission);
};

const hasModelPermission = (
    permissions: any,
    isSelf: boolean,
    action: ModelPermissionAction,
    userPermissions: string[] | undefined
): boolean => {
    const scope = isSelf ? "self" : "others";
    const rule = permissions?.[scope];
    if (!rule) return false;
    const isPublic = action === "create" ? rule.publicCreate === true : rule.publicDelete === true;
    if (isPublic) return true;
    const requiredPermission = rule[action];
    if (!requiredPermission) return false;
    return (userPermissions || []).includes(requiredPermission);
};

export class SchemaGuard {

    private static getModelByRefName(refName: string): Model<any> | null {
        try {
            const modelNames = mongoose.modelNames();
            const matchingName = modelNames.find(n => n.toLowerCase() === refName.toLowerCase());
            return matchingName ? mongoose.model(matchingName) : null;
        } catch {
            return null;
        }
    }

    private static resolveSchemaForType(schemaType: SchemaType) {
        const ref = schemaType.options?.ref || (schemaType as any)?.caster?.options?.ref;
        if (ref) return SchemaGuard.getModelByRefName(ref)?.schema;
        return schemaType.schema || (schemaType as any)?.caster?.schema;
    }

    /* ---------------------------------------------
       PERMISSION SANITIZATION (UNCHANGED)
    ---------------------------------------------- */

    private static filterFieldsAgainstSchema(
        schema: mongoose.Schema,
        fields: Record<string, any>,
        action: PermissionAction,
        userCtx: UserContext
    ): Record<string, any> | undefined {

        const result: Record<string, any> = {};

        for (const [field, config] of Object.entries(fields)) {
            if (field === "_id") continue;

            if( field === "roles" ){
                let a = 5;
            }

            const schemaType = schema.path(field);
            if (!schemaType) continue;

            const nestedKeys = config?.keys;

            if (nestedKeys && Object.keys(nestedKeys).length > 0) {
                // Gate: user must have permission on this field first (e.g. reservedBy on Reservation)
                const fieldPermissions = schemaType.options?.permissions;
                //@ts-expect-error
                if (!hasFieldPermission(fieldPermissions, userCtx.isSelf, action, userCtx.permissions, schema?.options?.accessMode)) continue;

                const nestedSchema = SchemaGuard.resolveSchemaForType(schemaType);
                if (!nestedSchema) continue;

                const filtered = SchemaGuard.filterFieldsAgainstSchema(
                    nestedSchema,
                    nestedKeys,
                    action,
                    userCtx
                );

                if (filtered && Object.keys(filtered).length) {
                    result[field] = { keys: filtered };
                } else {
                    // For non-refs (embedded docs, array subdocuments like costBreakdown): element
                    // schemas may not have role-assigned permissions. If user has permission on
                    // this field, include the nested keys. For refs, never fall back—nested keys
                    // must pass their own schema check.
                    const isRef = Boolean(schemaType.options?.ref) || Boolean((schemaType as any)?.caster?.options?.ref);
                    if (!isRef) {
                        const fieldPermissions = schemaType.options?.permissions;
                        //@ts-expect-error
                        if (hasFieldPermission(fieldPermissions, userCtx.isSelf, action, userCtx.permissions, schema?.options?.accessMode)) {
                            result[field] = { keys: nestedKeys };
                        }
                    }
                }
            } else {
                const fieldPermissions = schemaType.options?.permissions;
                //@ts-expect-error
                if (!hasFieldPermission(fieldPermissions, userCtx.isSelf, action, userCtx.permissions, schema?.options?.accessMode)) continue;
                result[field] = config;
            }
        }

        return Object.keys(result).length ? result : undefined;
    }

    static sanitizeFields<T extends Document>(
        model: Model<T>,
        fields: UnSanitizedFields,
        action: PermissionAction,
        userCtx: UserContext,
        languageCode = CONSTANTS.DEFAULT_LANGUAGE
    ): SanitizedFields {

        const sanitized: SanitizedFields = {};

        for (const [field, config] of Object.entries(fields)) {
            if(field === "_id") continue;

            if( field === "roles"){
                let a = 5;
            }

            const schemaType = model.schema.path(field);
            if (!schemaType) continue;

            const nestedKeys = config?.keys;

            if (nestedKeys && Object.keys(nestedKeys).length > 0) {
                // Gate: user must have permission on this field first (e.g. reservedBy on Reservation)
                const fieldPermissions = schemaType.options?.permissions;
                //@ts-expect-error
                if (!hasFieldPermission(fieldPermissions, userCtx.isSelf, action, userCtx.permissions, model.schema?.options?.accessMode)) continue;

                const nestedSchema = SchemaGuard.resolveSchemaForType(schemaType);
                if (!nestedSchema) continue;

                const filtered = SchemaGuard.filterFieldsAgainstSchema(
                    nestedSchema,
                    nestedKeys,
                    action,
                    userCtx
                );

                if (filtered && Object.keys(filtered).length) {
                    sanitized[field] = { keys: filtered };
                } else {
                    // For non-refs (embedded docs, array subdocuments like costBreakdown): element
                    // schemas may not have role-assigned permissions. If user has permission on
                    // this field, include the nested keys. For refs, never fall back—nested keys
                    // must pass their own schema check.
                    const isRef = Boolean(schemaType.options?.ref) || Boolean((schemaType as any)?.caster?.options?.ref);
                    if (!isRef) {
                        const fieldPermissions = schemaType.options?.permissions;
                        //@ts-expect-error
                        if (hasFieldPermission(fieldPermissions, userCtx.isSelf, action, userCtx.permissions, model.schema?.options?.accessMode)) {
                            sanitized[field] = { keys: nestedKeys };
                        }
                    }
                }
            } else {
                const fieldPermissions = schemaType.options?.permissions;
                //@ts-expect-error
                if (!hasFieldPermission(fieldPermissions, userCtx.isSelf, action, userCtx.permissions, model.schema?.options?.accessMode)) continue;
                sanitized[field] = config;
            }
        }

        if (!Object.keys(sanitized).length) {
            throw apiValidationException(
                "user_permissions_not_sufficient",
                null,
                null,
                languageCode
            );
        }

        return sanitized;
    }

    static checkModelPermission<T extends Document>(
        model: Model<T>,
        action: ModelPermissionAction,
        userCtx: UserContext,
        languageCode = CONSTANTS.DEFAULT_LANGUAGE
    ): boolean {

        const permissions = (model.schema as any).options?.permissions;
        if (!hasModelPermission(permissions, userCtx.isSelf, action, userCtx.permissions)) {
            throw apiValidationException("user_permissions_not_sufficient", null, null, languageCode);
        }

        return true;
    }

    /* ---------------------------------------------
       🔥 FIXED: DEEP POPULATE BUILDER
    ---------------------------------------------- */

    private static buildPopulate(
        fields: SanitizedFields,
        schema: Schema
    ): PopulateResult {

        const select: string[] = [];
        const populate: any[] = [];

        for (const [field, config] of Object.entries(fields)) {
            const schemaType = schema.path(field);
            if (!schemaType) continue;

            const nestedKeys = config?.keys;

            // ---- LEAF ----
            if (!nestedKeys || !Object.keys(nestedKeys).length) {
                select.push(field);
                continue;
            }

            const isRef =
                Boolean(schemaType.options?.ref) ||
                Boolean((schemaType as any)?.caster?.options?.ref);

            // ---- EMBEDDED ----
            if (!isRef) {
                const embeddedSchema = SchemaGuard.resolveSchemaForType(schemaType);
                if (!embeddedSchema) continue;

                const child = SchemaGuard.buildPopulate(nestedKeys, embeddedSchema);

                if( child.select.length > 0 ){
                    child.select.push("_id");
                }

                select.push(...child.select.map(s => `${field}.${s}`));
                populate.push(...child.populate.map(p => ({
                    ...p,
                    path: `${field}.${p.path}`
                })));

                continue;
            }

            // ---- REF ----
            const refSchema = SchemaGuard.resolveSchemaForType(schemaType);
            if (!refSchema) continue;

            const child = SchemaGuard.buildPopulate(nestedKeys, refSchema);

            const pop: any = {
                path: field
            };

            if (child.select.length) {
                pop.select = child.select.join(" ");
            }

            if (child.populate.length) {
                pop.populate =
                    child.populate.length === 1
                        ? child.populate[0]
                        : child.populate;
            }

            populate.push(pop);
            select.push(field);
        }

        return { select, populate };
    }

    /* ---------------------------------------------
       FINAL OUTPUT
    ---------------------------------------------- */

    static generatePopulate(
        fetchConfig: SanitizedFields,
        schema: Schema
    ): { select?: string; populate?: any | any[] } {

        const { select, populate } = SchemaGuard.buildPopulate(fetchConfig, schema);

        const uniqueSelect = Array.from(new Set(select)).join(" ");

        return {
            ...(uniqueSelect ? { select: uniqueSelect } : {}),
            ...(populate.length
                ? { populate: populate.length === 1 ? populate[0] : populate }
                : {})
        };
    }
}

export default SchemaGuard;
