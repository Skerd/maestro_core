import authMW, {AuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import {rateLimiter} from "@coreModule/utilities/middlewares/rateLimiter";
import {asyncHandler} from "@coreModule/utilities/middlewares/asyncHandler";
import {Router} from "express";
import {TableConfiguration} from "armonia/src/modules/core/api/auxiliary/private/tableConfigs/tableConfig.dto";
import {COLLECTED_DATA} from "@coreModule/database/collections";
import SchemaGuard from "@coreModule/database/security/schemaGuard";
import {filterTableConfigBySanitizedFields} from "@coreModule/database/filter/schemaToTableConfig";

/**
 * Table Configurations Endpoint (Private)
 *
 * This module provides a private endpoint for table configuration:
 * - GET /tableConfigurations — Column and filter config for all collections (cities, states, countries, etc.)
 *
 * Each collection's config is filtered by the user's read permissions via SchemaGuard.
 * Collections with no permitted fields are omitted.
 *
 * @module f_endpoints/core/auxiliary/tableConfigs
 */
const router = Router();

/**
 * GET /api/auxiliary/tableConfigurations
 *
 * Returns table configuration (columns + filters) for all collections in COLLECTED_DATA.
 * Each collection's config is filtered by the user's readFields allowlist; collections
 * with no permitted fields are omitted.
 *
 * @route GET /api/auxiliary/tableConfigs
 * @access Private
 * @returns {Promise<TableConfiguration>} Map of collection key to table config
 *
 * @remarks
 * - Iterates COLLECTED_DATA; requires model, readFields, tableConfiguration per entry
 */
router.get(
    "",
    authMW("private"),
    rateLimiter({ windowMs: 60000, max: 60 }),
    asyncHandler(getTableConfigurations)
);
type GetCityTableConfigType = AuthenticatedMWType;

/**
 * Table configuration for all collections (filters + columns).
 *
 * @param params - Auth context (actionUserCtx, languageCode)
 * @returns Column config per collection, filtered by read allowlist
 * @remarks Each collection's config is filtered by the user's read permissions via readFields
 */
async function getTableConfigurations(params: GetCityTableConfigType): Promise<TableConfiguration> {
    const {actionUserCtx, languageCode} = params;
    const returnThis: TableConfiguration = {};

    for (const key of Object.keys(COLLECTED_DATA)) {
        const {model, readFields, tableConfiguration} = COLLECTED_DATA[key];
        if (!model || !readFields || !tableConfiguration) continue;
        try{
            const sanitizedReadFields = SchemaGuard.sanitizeFields(model, readFields, "read", actionUserCtx, languageCode);
            if (Object.keys(sanitizedReadFields).length === 0) continue;
            returnThis[key] = filterTableConfigBySanitizedFields(tableConfiguration, sanitizedReadFields);
        }catch(err){
            console.log(err);
        }
    }

    return returnThis;
}

export { router };