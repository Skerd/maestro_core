import authMW, {AuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import {rateLimiter} from "@coreModule/utilities/middlewares/rateLimiter";
import {asyncHandler} from "@coreModule/utilities/middlewares/asyncHandler";
import {Router} from "express";
import {COLLECTED_DATA, getModelCollectedData} from "@coreModule/database/collections";
import SchemaGuard from "@coreModule/database/security/schemaGuard";
import type {ViewConfig, ViewConfiguration, ViewNode} from "armonia/src/modules/core/api/auxiliary/private/viewConfig";
import type {SanitizedFields} from "armonia/src/modules/core/types";

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/auxiliary/viewConfigs
// Bulk: returns every registered view config, permission-filtered.
// ---------------------------------------------------------------------------

router.get(
    "",
    authMW("private"),
    rateLimiter({ windowMs: 60000, max: 60 }),
    asyncHandler(getAllViewConfigs)
);

type ViewConfigParams = AuthenticatedMWType;

async function getAllViewConfigs(params: ViewConfigParams): Promise<ViewConfiguration> {
    const { actionUserCtx, languageCode } = params;
    const result: ViewConfiguration = {};

    for (const [collectionName, entry] of Object.entries(COLLECTED_DATA)) {
        const { model, readFields, writeFields, views } = entry;
        if (!model || !readFields || !views) continue;

        try {
            const sanitizedRead = SchemaGuard.sanitizeFields(model, readFields, "read", actionUserCtx, languageCode);
            if (Object.keys(sanitizedRead).length === 0) continue;

            let sanitizedWrite: SanitizedFields = {};
            if( !!writeFields ){
                try{
                    sanitizedWrite = SchemaGuard.sanitizeFields(model, writeFields, "write", actionUserCtx, languageCode);
                }catch (e){}
            }

            const filteredViews: Record<string, ViewConfig> = {};
            for (const [viewKey, viewConfig] of Object.entries(views)) {
                const filtered = filterViewConfig(viewConfig, sanitizedRead, sanitizedWrite);
                if (filtered) filteredViews[viewKey] = filtered;
            }

            if (Object.keys(filteredViews).length > 0) {
                result[collectionName] = filteredViews;
            }
        } catch (err) {
            console.error(`[viewConfigs] Error processing ${collectionName}:`, err);
        }
    }

    return result;
}

// ---------------------------------------------------------------------------
// GET /api/auxiliary/viewConfigs/:model/:viewKey
// Single: returns one view config for a specific model and view key.
// ---------------------------------------------------------------------------

router.get(
    "/:model/:viewKey",
    authMW("private"),
    rateLimiter({ windowMs: 60000, max: 120 }),
    asyncHandler(getSingleViewConfig)
);

type SingleViewConfigParams = AuthenticatedMWType & {
    model: string;
    viewKey: string;
};

async function getSingleViewConfig(params: SingleViewConfigParams): Promise<ViewConfig | null> {
    const { actionUserCtx, languageCode, model, viewKey } = params;

    const entry = getModelCollectedData(model);
    if (!entry?.views?.[viewKey] || !entry.model || !entry.readFields) return null;

    const sanitizedRead = SchemaGuard.sanitizeFields(entry.model, entry.readFields, "read", actionUserCtx, languageCode);
    if (Object.keys(sanitizedRead).length === 0) return null;

    const sanitizedWrite = entry.writeFields
        ? SchemaGuard.sanitizeFields(entry.model, entry.writeFields, "write", actionUserCtx, languageCode)
        : {};

    return filterViewConfig(entry.views[viewKey], sanitizedRead, sanitizedWrite);
}

// ---------------------------------------------------------------------------
// Permission-aware tree filtering
// ---------------------------------------------------------------------------

function filterViewConfig(
    config: ViewConfig,
    readFields: SanitizedFields,
    writeFields: SanitizedFields
): ViewConfig | null {
    /** Create forms show all fields; write-allowlist → `disabled` only applies to edit (and legacy forms without viewMode). */
    const applyWriteAllowlistAsDisabled =
        config.viewType === "form" && config.viewMode !== "create";
    const filteredNodes = filterNodes(
        config.nodes,
        readFields,
        writeFields,
        applyWriteAllowlistAsDisabled,
        /** Sheets lock an unreadable card rather than dropping it — see `lockCardInstead`. */
        config.viewType === "sheet"
    );
    if (filteredNodes.length === 0) return null;
    return { ...config, nodes: filteredNodes };
}

/**
 * A sheet `#DisplayCard` the account cannot read is served locked instead of being dropped:
 * a field missing from a sheet reads as "this entity has no such data", which is a different
 * (and wrong) statement from "you may not see this". Only cards, and only sheets — a layout
 * node or a media strip has nothing to render a lock in, so those still go.
 */
function lockCardInstead(node: ViewNode, lockUnreadableCards: boolean): ViewNode | null {
    if (!lockUnreadableCards || node.render !== "#DisplayCard" || !node.field) return null;
    return { ...node, field: { ...node.field, locked: true }, children: undefined };
}

function filterNodes(
    nodes: ViewNode[],
    readFields: SanitizedFields,
    writeFields: SanitizedFields,
    applyWriteAllowlistAsDisabled: boolean,
    lockUnreadableCards = false
): ViewNode[] {
    const result: ViewNode[] = [];

    for (const node of nodes) {
        if (node.permissions?.readAny?.length) {
            if (!node.permissions.readAny.some((k) => hasField(readFields, k))) {
                const locked = lockCardInstead(node, lockUnreadableCards);
                if (locked) result.push(locked);
                continue;
            }
        } else if (node.permissions?.read && !hasField(readFields, node.permissions.read)) {
            const locked = lockCardInstead(node, lockUnreadableCards);
            if (locked) result.push(locked);
            continue;
        }
        if (node.dependentAny?.length) {
            if (
                !node.dependentRuntimeOnly &&
                !node.dependentAny.some((d) => hasField(readFields, d))
            ) {
                continue;
            }
        } else if (
            node.dependent &&
            !node.dependentRuntimeOnly &&
            !hasField(readFields, node.dependent)
        ) {
            continue;
        }

        let processedNode = { ...node };

        if (processedNode.field && applyWriteAllowlistAsDisabled) {
            const fieldName = processedNode.field.name;
            /** Virtual compound fields gate permissions inside the widget (e.g. floor project/edifice). */
            const skipWriteDisabled =
                fieldName === "_id" ||
                fieldName === "__floorPolygon" ||
                fieldName === "__unitRefs" ||
                fieldName === "__unitPolygon" ||
                fieldName === "__unitConnected" ||
                !!processedNode.field.skipWriteAccessGate ||
                processedNode.field.widget === "#FormFloorPolygon" ||
                processedNode.field.widget === "#FormUnitPolygon";
            if (!skipWriteDisabled && !hasField(writeFields, fieldName)) {
                processedNode = {
                    ...processedNode,
                    field: { ...processedNode.field, disabled: true },
                };
            }
        }

        if (processedNode.children) {
            processedNode = {
                ...processedNode,
                children: filterNodes(
                    processedNode.children,
                    readFields,
                    writeFields,
                    applyWriteAllowlistAsDisabled,
                    lockUnreadableCards
                ),
            };
        }

        result.push(processedNode);
    }

    return result;
}

/**
 * Checks whether a dot-separated field path exists in the sanitized field map.
 * Supports nested paths (e.g. "currency.abbreviation").
 */
function hasField(fields: SanitizedFields, path: string): boolean {
    const segments = path.split(".");
    let current: SanitizedFields | undefined = fields;
    for (const seg of segments) {
        if (!current || !(seg in current)) return false;
        current = current[seg]?.keys;
    }
    return true;
}

export { router };
