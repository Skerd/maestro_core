import {type Model, Schema, SchemaTypes} from "mongoose";
import type {ClientSession} from "mongoose";
import type {ObjectId} from "mongodb";
import {asCrossTenant, withTenant} from "@coreModule/utilities/endpoints/tenantScope";
import {nestedEntityToRef} from "@coreModule/utilities/mappers/common.mapper";
import {auditOperatorUpdate} from "@coreModule/database/plugins/auditPlugin";

/** Field added by platformHiddenPlugin. */
export interface IPlatformHiddenPluginFields {
    hiddenByPlatform?: boolean;
}

// Written only by the platform's report desk; the owner's staff read it (their panel shows the record as hidden).
const PLATFORM_WRITTEN = {
    self: {write: "no-permission"},
    others: {write: "no-permission"},
} as const;

/**
 * Lets the platform hide one company's public record after a report (D191), the way platformOnlyPlugin and
 * requestablePlugin mark what the platform owns: the record stays the company's, its own panel still lists it (marked),
 * and every public read leaves it out with {@link notHiddenByPlatform}. Only the report desk writes the flag
 * ({@link setHiddenByPlatform}), through a reportable that names the model (`ReportableDefinition.model`).
 */
export const platformHiddenPlugin = (schema: Schema): void => {
    schema.add({
        hiddenByPlatform: {
            type: SchemaTypes.Boolean,
            default: false,
            permissions: PLATFORM_WRITTEN,
            dynamicTableConfiguration: {visible: false},
        },
    });
    schema.set("platformHidden", true);
};

/** Whether `model` applies platformHiddenPlugin. */
export function isPlatformHideable(model: Model<any>): boolean {
    return model.schema.get("platformHidden") === true;
}

/**
 * The clause every public read of a hideable model adds (portal, company site, ratings, search): the rows the platform
 * hid are left out. Not applied by itself: the owner's panel and the platform's desk still read hidden rows.
 */
export function notHiddenByPlatform(): {hiddenByPlatform: {$ne: true}} {
    return {hiddenByPlatform: {$ne: true}};
}

/**
 * Hides one record from the public, or shows it again, with an audit entry naming the platform admin (`decidedBy`). The record is found by its id across companies and saved in the company that keeps it, whatever tenant
 * the caller runs in (a marketplace quote lives in the job's company, its report names the quoting one). Answers that
 * company, or null when the record no longer exists.
 */
export async function setHiddenByPlatform(
    model: Model<any>,
    recordId: ObjectId,
    hidden: boolean,
    options: {decidedBy: ObjectId; session?: ClientSession; module?: string},
): Promise<ObjectId | null> {
    if (!isPlatformHideable(model)) {
        throw new Error(`${model.modelName} does not apply platformHiddenPlugin`);
    }
    const session = options.session ?? null;
    const before = await asCrossTenant("the platform's report desk hides a reported record in its own company (D191)",
        () => model.findById(recordId).session(session).lean<Record<string, unknown>>());
    const companyId = before ? nestedEntityToRef(before.company) : undefined;
    if (!before || !companyId) return null;
    // Only the flag changes, so only it is validated: an older record missing a newer required field still hides.
    await withTenant(companyId, async () => {
        await model.updateOne({_id: recordId}, {$set: {hiddenByPlatform: hidden}}, {session});
        const after = await model.findById(recordId).session(session).lean<Record<string, unknown>>();
        await auditOperatorUpdate(model, before, after, options.decidedBy, session);
    }, options.module);
    return companyId;
}
