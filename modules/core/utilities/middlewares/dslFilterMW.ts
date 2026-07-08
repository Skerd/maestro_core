import {NextFunction, Request, Response} from "express";
import type {FilterQuery} from "mongoose";
import type {FilterGroup} from "armonia/src/modules/core/database/filter/filter.types";
import type {SanitizedFields} from "armonia/src/modules/core/types";
import {getModelCollectedData} from "@coreModule/database/collections";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {buildMongoQuery} from "@coreModule/database/filter/filterQueryBuilder";
import {filterTableConfigBySanitizedFields} from "@coreModule/database/filter/schemaToTableConfig";
import {createFieldRegistry} from "armonia/src/modules/core/database/filter/fieldRegistry.types";
import {tableConfigToFilterConfig} from "armonia/src/modules/core/database/filter/pathUtils";
import {CONSTANTS} from "@coreModule/environment";

export type DslFilterQuery = FilterQuery<unknown>;

/** Params attached by dslFilterMW to req.body; use in handler param types when route includes dslFilterMW */
export type DslFilterMWType = {
    dslFilterQuery?: DslFilterQuery;
};

export type DslFilterMWOptions = {
    /** Collection name (e.g. "roles", "users") - used to fetch tableConfiguration from getModelCollectedData */
    model: string;
    /** Request body field that carries the FilterGroup (default: "filter"). Use "filters" for the select route. */
    fieldName?: string;
};

/**
 * DSL Filter Middleware
 *
 * Uses getModelCollectedData(model).tableConfiguration. Converts a filter DSL from req.body.filter
 * into a MongoDB FilterQuery using field-level permissions. Attaches the result to req.body.dslFilterQuery.
 *
 * Requires schemaSanitizer (or equivalent) to run first and attach req.body.sanitizedReadFields.
 * Only processes when filter has rules or groups; otherwise dslFilterQuery is undefined.
 *
 * @param options.model - Collection name for tableConfiguration lookup
 *
 * @example
 * ```typescript
 * router.post(
 *   "",
 *   authMW("private"),
 *   rateLimiter({ ... }),
 *   schemaSanitizer({ model: "users", mode: "read" }),
 *   validateFormZod(getAllUsersFormSchema),
 *   dslFilterMW({ model: "users" }),
 *   asyncHandler(getCompanyUsers)
 * );
 *
 * // In handler:
 * if (params.dslFilterQuery && Object.keys(params.dslFilterQuery as object).length > 0) {
 *   filterQuery.$and = [...(filterQuery.$and ?? []), params.dslFilterQuery];
 * }
 * ```
 */
export function dslFilterMW(options: DslFilterMWOptions) {
    const { model: modelName, fieldName = "filter" } = options;

    return (req: Request, _res: Response, next: NextFunction) => {
        const body = req.body ?? {};
        const sanitizedFields = body.sanitizedReadFields as SanitizedFields | undefined;
        const filter = body[fieldName] as FilterGroup | undefined;

        const useFilterDsl = filter && (filter.rules?.length > 0 || filter.groups?.length > 0);

        if (!useFilterDsl) {
            req.body.dslFilterQuery = undefined;
            return next();
        }

        if (!sanitizedFields) {
            const languageCode = body.languageCode ?? CONSTANTS.DEFAULT_LANGUAGE;
            return next(
                apiValidationException("dsl_filter_sanitized_read_fields_required", null as any, null, languageCode)
            );
        }

        const { tableConfiguration } = getModelCollectedData(modelName);

        if (!tableConfiguration) {
            const languageCode = body.languageCode ?? CONSTANTS.DEFAULT_LANGUAGE;
            return next(
                apiValidationException("dsl_filter_table_config_not_found", null as any, null, languageCode)
            );
        }

        const tableConfig = filterTableConfigBySanitizedFields(tableConfiguration, sanitizedFields);
        const filterRegistry = createFieldRegistry(tableConfigToFilterConfig(tableConfig));
        const dslQuery = buildMongoQuery(filter, filterRegistry);

        req.body.dslFilterQuery =
            dslQuery && Object.keys(dslQuery as object).length > 0 ? (dslQuery as DslFilterQuery) : undefined;

        next();
    };
}
