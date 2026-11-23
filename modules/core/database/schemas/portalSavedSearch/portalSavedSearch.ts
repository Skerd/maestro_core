import {Document, model, Schema, SchemaTypes} from "mongoose";
import type {ObjectId} from "mongodb";
import {IUser} from "@coreModule/database/schemas/user/user";
import {normalizeSchemaPermissions} from "@coreModule/database/utilities";
import ownershipPlugin from "@coreModule/database/plugins/ownershipPlugin";
import auditPlugin from "@coreModule/database/plugins/auditPlugin";
import softDeletePlugin from "@coreModule/database/plugins/softDeletePlugin";
import lifeCyclePlugin from "@coreModule/database/plugins/lifeCyclePlugin";
import {ILifeCyclePluginFields, IOwnershipPluginFields, ISoftDeletePluginFields} from "@coreModule/database/types/plugin-fields";
import {addModelData} from "@coreModule/database/collections";
import {SimpleUserSnippet} from "@coreModule/database/schemas/user/user.snippets";
import type {PortalBrowseFilters} from "armonia/src/modules/core/api/portal/public/portal/portalBrowse.form.validator";
import {SUPPORTED_LOCALES, type SupportedLocale} from "armonia/src/modules/core/constants";
import {applyPortalSavedSearchIndexes} from "./portalSavedSearch.indexes";

const serverWritten = {
    self: {write: "no-permission"},
    others: {write: "no-permission"},
};

/**
 * A search a person saved on the portal (D178, P23.7): the home catalog's browse query itself, on the host it was saved
 * on. A daily core job (`core.savedSearchAlerts`) asks the portal's sections for items listed since `lastAlertAt` and
 * emails the person a digest while `alerts` is on. One list per person across every company, stored in the platform
 * company like the address book (D163); the routes read and write only the signed-in person's rows.
 */
export interface IPortalSavedSearch extends Document, IOwnershipPluginFields, ISoftDeletePluginFields, ILifeCyclePluginFields {
    user: IUser;
    /** The search as words in the person's language, e.g. "Cars · Tirana · up to €50". */
    label: string;
    kind?: string;
    query?: string;
    city?: string;
    priceMin?: number;
    priceMax?: number;
    filters: PortalBrowseFilters;
    /** The company whose own site it was saved on; absent on the apex. Its alert searches that host's catalog. */
    siteCompany?: ObjectId;
    /** The language it was saved in, for the alert when the person has not picked one. */
    languageCode: SupportedLocale;
    alerts: boolean;
    /** Items listed after this went into an alert yet; set when saved and after each alert. */
    lastAlertAt: Date;
}

const PortalSavedSearchSchema = new Schema<IPortalSavedSearch>(
    {
        // The owner, set by the server from the session and never changed.
        user: {type: SchemaTypes.ObjectId, ref: "User", required: true, immutable: true, refAllowlist: SimpleUserSnippet, permissions: serverWritten},
        label: {type: SchemaTypes.String, required: true, trim: true, maxlength: 160, permissions: serverWritten},
        kind: {type: SchemaTypes.String, trim: true, maxlength: 32, permissions: serverWritten},
        query: {type: SchemaTypes.String, trim: true, maxlength: 200, permissions: serverWritten},
        city: {type: SchemaTypes.String, trim: true, maxlength: 200, permissions: serverWritten},
        priceMin: {type: SchemaTypes.Number, min: 0, permissions: serverWritten},
        priceMax: {type: SchemaTypes.Number, min: 0, permissions: serverWritten},
        // The kind's own `f.<name>` filters, validated by the browse form (string or list of strings per name).
        filters: {type: SchemaTypes.Mixed, default: {}, permissions: serverWritten},
        siteCompany: {type: SchemaTypes.ObjectId, ref: "Company", immutable: true, permissions: serverWritten},
        languageCode: {type: SchemaTypes.String, enum: [...SUPPORTED_LOCALES], required: true, permissions: serverWritten},
        alerts: {type: SchemaTypes.Boolean, default: true, permissions: serverWritten},
        lastAlertAt: {type: SchemaTypes.Date, required: true, permissions: serverWritten},
    },
    {accessMode: "loose"},
);

// Not tenant-scoped: every row is stored in the platform company and every query names its rows (like D163).
ownershipPlugin(PortalSavedSearchSchema, {tenantScoped: false});
auditPlugin(PortalSavedSearchSchema);
softDeletePlugin(PortalSavedSearchSchema);
lifeCyclePlugin(PortalSavedSearchSchema);
applyPortalSavedSearchIndexes(PortalSavedSearchSchema);
const PortalSavedSearch = model<IPortalSavedSearch>("PortalSavedSearch", PortalSavedSearchSchema);
normalizeSchemaPermissions(PortalSavedSearch);
export default PortalSavedSearch;

addModelData(PortalSavedSearch);
