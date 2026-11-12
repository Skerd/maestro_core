import type {Model} from "mongoose";
import {getModelCollectedData} from "@coreModule/database/collections";
import SchemaGuard from "@coreModule/database/security/schemaGuard";
import type {UserContext} from "@coreModule/utilities/types/types";

export type ReadableListFetchCtx = {actionUserCtx: UserContext; languageCode: string};

/**
 * The populate and projection the caller's role allows on a model's list, or null when it allows nothing.
 *
 * Record hubs (UX-03) embed other models' lists in a sheet; each list must be read the way its own list route reads
 * it (SEC-09), so a role that cannot read the model gets no list at all instead of an error.
 */
export function readableListFetch(model: Model<any>, ctx: ReadableListFetchCtx): ReturnType<typeof SchemaGuard.generatePopulate> | null {
    const collected = getModelCollectedData(model.collection.name).readFields;
    if (!collected) return null;
    try {
        const readFields = SchemaGuard.sanitizeFields(model, collected, "read", ctx.actionUserCtx, ctx.languageCode);
        return Object.keys(readFields).length ? SchemaGuard.generatePopulate(readFields, model.schema) : null;
    } catch {
        // sanitizeFields refuses a role with no readable field: that list is simply not shown.
        return null;
    }
}
