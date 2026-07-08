import {SanitizedFields} from "armonia/src/modules/core/types";
import {Model} from "mongoose";
import {schemaToFieldAllowlist} from "@coreModule/database/filter/schemaToFieldAllowlist";
import type {
    TableColumnConfig
} from "armonia/src/modules/core/api/company/private/users/tableConfig.form.response.type";
import {buildTableConfig} from "@coreModule/database/filter/schemaToTableConfig";
import type {ViewConfig} from "armonia/src/modules/core/api/auxiliary/private/viewConfig";
import {viewConfigKey} from "armonia/src/modules/core/api/auxiliary/private/viewConfig";

export type ModelCollectedData = {
    model: Model<any>;
    readFields: SanitizedFields;
    writeFields: SanitizedFields;
    tableConfiguration: TableColumnConfig[];
    views: Record<string, ViewConfig>;
};

export const COLLECTED_DATA: Record<string, ModelCollectedData> = {};

/** Normalizes UI/API collection keys (e.g. `productCollections`) to Mongoose collection names (`productcollections`). */
export function resolveCollectionKey(key: string): string {
    return key.toLowerCase();
}

export function addModelData(model: Model<any>, views?: ViewConfig[]): void {
    const readFields = schemaToFieldAllowlist(model.schema);
    COLLECTED_DATA[model.collection.name] = {
        model,
        readFields,
        writeFields: schemaToFieldAllowlist(model.schema, { permission: "write" }),
        tableConfiguration: buildTableConfig(model, readFields),
        views: {}
    };
    if( !!views ){
        for (const view of views) {
            COLLECTED_DATA[model.collection.name]["views"][viewConfigKey(view)] = view;
        }
    }
}

export function getModelCollectedData(model: string): Partial<ModelCollectedData> {
    if (!model) return {};
    const normalized = resolveCollectionKey(model);
    return COLLECTED_DATA[normalized] ?? COLLECTED_DATA[model] ?? {};
}