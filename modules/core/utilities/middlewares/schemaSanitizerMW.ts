import {NextFunction, Request, Response} from "express";
import SchemaGuard from "@coreModule/database/security/schemaGuard";
import type {SanitizedFields} from "armonia/src/modules/core/types";
import {getModelCollectedData} from "@coreModule/database/collections";
import {filterTableConfigBySanitizedFields} from "@coreModule/database/filter/schemaToTableConfig";
import type {
    TableColumnConfig
} from "armonia/src/modules/core/api/company/private/users/tableConfig.form.response.type";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {CONSTANTS} from "@coreModule/environment";

export type Sanitized = {
    sanitizedReadFields: SanitizedFields;
    sanitizedWriteFields: SanitizedFields;
    /** Filtered table config when read mode is required and model has tableConfiguration */
    tableConfig?: TableColumnConfig[];
};

/** Params attached by schemaSanitizer to req.body; use in handler param types when route includes schemaSanitizer.
 *  tableConfig is set when requiredModes includes "read" and the model has tableConfiguration. */
export type SchemaSanitizerMWType = Sanitized;

export type SchemaSanitizerOptions = {
    /** Collection name (e.g. "roles", "users") - used to fetch readFields/writeFields from getModelCollectedData */
    model: string;
    /** Modes required; each must yield a non-empty sanitized result or an error is thrown */
    requiredModes: ("read" | "write")[];
};

/**
 * Schema Sanitizer Middleware
 *
 * Uses getModelCollectedData(model) for readFields/writeFields and tableConfiguration. Runs SchemaGuard.sanitizeFields
 * for each requiredModes and attaches sanitizedReadFields, sanitizedWriteFields. When read mode is required and the
 * model has tableConfiguration, also attaches tableConfig (filtered by sanitized read fields). If a required mode
 * yields no allowed fields, throws.
 *
 * @param options - model (collection name), requiredModes (non-empty array)
 *
 * @example
 * ```typescript
 * schemaSanitizer({ model: "currencies", requiredModes: ["write"] })
 * schemaSanitizer({ model: "roles", requiredModes: ["read"] })
 * schemaSanitizer({ model: "users", requiredModes: ["read", "write"] })
 * // In handler: const { sanitizedReadFields, sanitizedWriteFields, tableConfig } = params;
 * ```
 */
export function schemaSanitizer(options: SchemaSanitizerOptions) {
    const { model: modelName, requiredModes } = options;

    if (!requiredModes?.length) {
        throw new Error("schemaSanitizer: requiredModes must be a non-empty array of \"read\" and/or \"write\"");
    }

    return (req: Request, _res: Response, next: NextFunction) => {
        const body = req.body ?? {};
        const actionUserCtx = body.actionUserCtx;
        const languageCode = body.languageCode ?? CONSTANTS.DEFAULT_LANGUAGE;

        if (!actionUserCtx) {
            return next(
                apiValidationException("no_token", null, null, languageCode)
            );
        }

        const { model, readFields, writeFields, tableConfiguration } = getModelCollectedData(modelName);

        if (!model || !readFields || !writeFields) {
            return next(
                apiValidationException("schema_sanitizer_model_data_not_found", null as any, null, languageCode, [modelName])
            );
        }

        let sanitizedReadFields: SanitizedFields | undefined;
        let sanitizedWriteFields: SanitizedFields | undefined;

        if (requiredModes.includes("read")) {
            sanitizedReadFields = SchemaGuard.sanitizeFields(model, readFields, "read", actionUserCtx, languageCode);
            if (Object.keys(sanitizedReadFields).length === 0) {
                return next(
                    apiValidationException("schema_sanitizer_no_read_permission", null as any, null, languageCode)
                );
            }
        }

        if (requiredModes.includes("write")) {
            sanitizedWriteFields = SchemaGuard.sanitizeFields(model, writeFields, "write", actionUserCtx, languageCode);
            if (Object.keys(sanitizedWriteFields).length === 0) {
                return next(
                    apiValidationException("schema_sanitizer_no_write_permission", null as any, null, languageCode)
                );
            }
        }

        req.body.sanitizedReadFields = sanitizedReadFields;
        req.body.sanitizedWriteFields = sanitizedWriteFields;

        if (requiredModes.includes("read") && sanitizedReadFields && tableConfiguration) {
            req.body.tableConfig = filterTableConfigBySanitizedFields(tableConfiguration, sanitizedReadFields);
        }

        next();
    };
}
