import {Document, Model, SchemaType, SchemaTypes} from "mongoose";
import type {
    TableColumnConfig
} from "armonia/src/modules/core/api/company/private/users/tableConfig.form.response.type";
import {collectPathsFromSanitized} from "armonia/src/modules/core/database/filter/pathUtils";
import {SanitizedFields} from "armonia/src/modules/core/types";
import {
    BOOLEAN_OPERATORS,
    COLUMN_TYPE,
    DATE_OPERATORS,
    ENUM_OPERATORS,
    NUMBER_OPERATORS,
    OBJECT_ID_OPERATORS,
    STRING_OPERATORS
} from "armonia/src/modules/core/database/filter/typeOperators";
import {REF_SELECT_REGISTRY} from "armonia/src/modules/core/database/filter/refSelectRegistry";

function schemaTypeToFilterConfig(schemaType: SchemaType): TableColumnConfig["filterConfig"] {
    const options = schemaType.options ?? {};
    const opts = options as { enum?: string[]; ref?: string };
    const caster = (schemaType as any).caster;

    // const cfg = REF_SELECT_REGISTRY[f.ref];
    // return { ...f, apiUrl: cfg.apiUrl, postBodyKeys: cfg.postBodyKeys };

    // String with enum -> enum type
    if (schemaType instanceof SchemaTypes.String && Array.isArray(opts.enum)) {
        return {
            type: COLUMN_TYPE.ENUM,
            enumValues: opts.enum,
            operators: ENUM_OPERATORS,
        };
    }

    // String (no enum)
    if (schemaType instanceof SchemaTypes.String) {
        return {
            type: COLUMN_TYPE.STRING,
            operators: STRING_OPERATORS,
        };
    }

    // Number
    if (schemaType instanceof SchemaTypes.Number) {
        return {
            type: COLUMN_TYPE.NUMBER,
            operators: NUMBER_OPERATORS,
        };
    }

    // Date
    if (schemaType instanceof SchemaTypes.Date) {
        return {
            type: COLUMN_TYPE.DATE,
            operators: DATE_OPERATORS,
        };
    }

    // Boolean
    if (schemaType instanceof SchemaTypes.Boolean) {
        return {
            type: COLUMN_TYPE.BOOLEAN,
            operators: BOOLEAN_OPERATORS,
        };
    }

    // ObjectId (single or array)
    if (schemaType instanceof SchemaTypes.ObjectId) {
        const ref = opts.ref ?? (caster?.options?.ref as string | undefined);
        let rest: Partial<TableColumnConfig["filterConfig"]> = {}
        if( !!ref && REF_SELECT_REGISTRY[ref] ){
            rest = {
                apiUrl: REF_SELECT_REGISTRY[ref].apiUrl,
                postBodyKeys: REF_SELECT_REGISTRY[ref].postBodyKeys,
            }
        }
        return {
            type: COLUMN_TYPE.OBJECT_ID,
            ref,
            operators: OBJECT_ID_OPERATORS,
            ...rest
        };
    }

    // Array of ObjectIds
    if (schemaType instanceof SchemaTypes.Array && caster) {
        if (caster instanceof SchemaTypes.ObjectId) {
            const ref = (caster as any).options?.ref ?? (opts.ref as string | undefined);
            let rest: Partial<TableColumnConfig["filterConfig"]> = {}
            if( !!ref && REF_SELECT_REGISTRY[ref] ){
                rest = {
                    apiUrl: REF_SELECT_REGISTRY[ref].apiUrl,
                    postBodyKeys: REF_SELECT_REGISTRY[ref].postBodyKeys,
                }
            }
            return {
                type: COLUMN_TYPE.OBJECT_ID,
                ref,
                operators: OBJECT_ID_OPERATORS,
                ...rest
            };
        }
    }

    // Unsupported type (Mixed, Map, etc.)
    return null;
}

function inferCellTypeFromSchemaType(schemaType: SchemaType): COLUMN_TYPE {
    const override = (schemaType.options as any)?.dynamicTableConfiguration?.cellType;
    if (override != null) return override as COLUMN_TYPE;

    const opts = (schemaType.options ?? {}) as { enum?: string[]; ref?: string };
    const caster = (schemaType as any).caster;
    const casterOpts = (caster?.options ?? {}) as { enum?: string[]; ref?: string };
    const enumValues = opts.enum ?? casterOpts.enum;
    const ref = opts.ref ?? casterOpts.ref;

    if (schemaType instanceof SchemaTypes.String) {
        return Array.isArray(opts.enum) ? COLUMN_TYPE.ENUM : COLUMN_TYPE.STRING;
    }
    if (schemaType instanceof SchemaTypes.Array) {
        if (caster instanceof SchemaTypes.ObjectId) return ref === "Media" ? COLUMN_TYPE.FILE : COLUMN_TYPE.OBJECT_ID;
        if (caster instanceof SchemaTypes.String && Array.isArray(enumValues)) return COLUMN_TYPE.ENUM;
        return COLUMN_TYPE.ARRAY;
    }
    if (schemaType instanceof SchemaTypes.Number) return COLUMN_TYPE.NUMBER;
    if (schemaType instanceof SchemaTypes.Date) return COLUMN_TYPE.DATETIME;
    if (schemaType instanceof SchemaTypes.Boolean) return COLUMN_TYPE.BOOLEAN;
    if (schemaType instanceof SchemaTypes.ObjectId) return ref === "Media" ? COLUMN_TYPE.FILE : COLUMN_TYPE.OBJECT_ID;
    if (schemaType instanceof SchemaTypes.Mixed) return COLUMN_TYPE.MIXED;

    return COLUMN_TYPE.UNKNOWN;
}

export function buildTableColumnsFromSchema<T extends Document>(model: Model<T>, allowedPaths: Set<string>, columnOrder: string[] = []): TableColumnConfig[] {

    const results: TableColumnConfig[] = [];
    const seenIds = new Set<string>();

    const addColumn = (config: TableColumnConfig) => {
        if (seenIds.has(config.id)) return;
        seenIds.add(config.id);
        results.push(config);
    };

    for (const path of allowedPaths) {

        if( path === "roles" ){
            let a = 5;
        }

        if (path === "_id" || path === "__v") {
            continue;
        }

        const schemaType = model.schema.path(path);
        const isArrayOfSubDocs = schemaType?.instance === 'Array' && !!schemaType.schema;
        if (!schemaType || schemaType?.instance === 'Embedded' || isArrayOfSubDocs) {

            if ((schemaType?.options as { dynamicTableConfiguration?: { hideColumn?: boolean } })?.dynamicTableConfiguration?.hideColumn === true) {
                continue;
            }

            if( !!schemaType?.options?.dynamicTableConfiguration ){
                addColumn({
                    id: path,
                    accessorPath: path,
                    labelKey: path,
                    cellType: schemaType?.options?.dynamicTableConfiguration?.cellType || COLUMN_TYPE.MIXED,
                    sortable: !(schemaType?.options?.dynamicTableConfiguration?.sortable === false),
                    visible: !(schemaType?.options?.dynamicTableConfiguration?.visible === false),
                });
            }
            continue;
        }
        if ((schemaType.options as { dynamicTableConfiguration?: { hideColumn?: boolean } })?.dynamicTableConfiguration?.hideColumn === true) {
            continue;
        }

        // const cellType = inferCellType(path, schemaType);
        const meta: TableColumnConfig["meta"] = {};
        // if (cellType === "date" || cellType === "datetime") {
        //     meta.timezonePath = "timezone";
        //     meta.dateFormat = cellType === "datetime" ? "datetime" : "date";
        // }
        // if (cellType === "badge" && path === "roles.active") {
        //     meta.badgeMapping = { active: "statuses.active", inactive: "statuses.inactive", invited: "statuses.invited" };
        // }
        // if (path === "photo") {
        //     meta.className = "w-12";
        // }

        let columnConfig: TableColumnConfig = {
            id: path,
            accessorPath: path,
            labelKey: path,
            cellType: inferCellTypeFromSchemaType(schemaType),
            sortable: !(schemaType?.options?.dynamicTableConfiguration?.sortable === false),
            visible: !(schemaType?.options?.dynamicTableConfiguration?.visible === false),
        }
        if( Object.keys(meta).length ){
            columnConfig["meta"] = meta;
        }
        if( !(schemaType?.options?.dynamicTableConfiguration?.filterable === false) ){
            columnConfig["filterConfig"] = schemaTypeToFilterConfig(schemaType);
        }
        if( !!schemaType?.options?.dynamicTableConfiguration?.dtoPath ){
            columnConfig["dtoPath"] = schemaType?.options?.dynamicTableConfiguration?.dtoPath;
        }
        if( Array.isArray(schemaType?.options?.dynamicTableConfiguration?.refDisplayKey) && schemaType.options.dynamicTableConfiguration.refDisplayKey.length > 0 ){
            columnConfig["meta"] = { ...columnConfig.meta, refDisplayKey: schemaType.options.dynamicTableConfiguration.refDisplayKey };
        }

        addColumn(columnConfig);
    }

    if (columnOrder.length > 0) {
        const byId = new Map(results.map((r) => [r.id, r]));
        const ordered: TableColumnConfig[] = [];
        for (const id of columnOrder) {
            const col = byId.get(id);
            if (col) {
                ordered.push(col);
                byId.delete(id);
            }
        }
        for (const col of results) {
            if (byId.has(col.id)) ordered.push(col);
        }
        return ordered;
    }

    return results;
}

export function buildTableConfig<T extends Document>(model: Model<T>, fieldAllowlist: SanitizedFields): TableColumnConfig[] {
    return buildTableColumnsFromSchema(model, collectPathsFromSanitized(fieldAllowlist));
}

export function filterTableConfigBySanitizedFields(tableConfig: TableColumnConfig[], sanitizedFields: SanitizedFields): TableColumnConfig[] {
    const allowedPaths = collectPathsFromSanitized(sanitizedFields);
    return tableConfig.filter((col) => {
        const path = col.accessorPath ?? col.id;
        return allowedPaths.has(path);
    });
}
