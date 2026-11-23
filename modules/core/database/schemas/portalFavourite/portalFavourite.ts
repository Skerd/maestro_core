import {Document, model, Schema, SchemaTypes} from "mongoose";
import {IUser} from "@coreModule/database/schemas/user/user";
import {normalizeSchemaPermissions} from "@coreModule/database/utilities";
import ownershipPlugin from "@coreModule/database/plugins/ownershipPlugin";
import auditPlugin from "@coreModule/database/plugins/auditPlugin";
import softDeletePlugin from "@coreModule/database/plugins/softDeletePlugin";
import lifeCyclePlugin from "@coreModule/database/plugins/lifeCyclePlugin";
import {ILifeCyclePluginFields, IOwnershipPluginFields, ISoftDeletePluginFields} from "@coreModule/database/types/plugin-fields";
import {addModelData} from "@coreModule/database/collections";
import {SimpleUserSnippet} from "@coreModule/database/schemas/user/user.snippets";
import {applyPortalFavouriteIndexes} from "./portalFavourite.indexes";

const serverWritten = {
    self: {write: "no-permission"},
    others: {write: "no-permission"},
};

/**
 * A catalog item a person keeps on the portal (D178, P23.7): the heart on a card. Like the address book (D163), one list
 * per person across every company, stored in the platform company; the routes in `api/portal/private/saved.ts` read and
 * write only the signed-in person's rows. The item is named by its catalog kind and id; its card is read live from the
 * section that lists it whenever it is shown, so no price is kept here.
 */
export interface IPortalFavourite extends Document, IOwnershipPluginFields, ISoftDeletePluginFields, ILifeCyclePluginFields {
    user: IUser;
    /** The catalog kind (`product`, `vehicleCategory`, …), as the portal's sections report it. */
    kind: string;
    /** The item's id in its section's catalog. */
    itemId: string;
    /** The section listing the item, and the item's page inside it, as the card that was hearted named them. */
    section: string;
    path: string;
}

const PortalFavouriteSchema = new Schema<IPortalFavourite>(
    {
        // The owner, set by the server from the session and never changed.
        user: {type: SchemaTypes.ObjectId, ref: "User", required: true, immutable: true, refAllowlist: SimpleUserSnippet, permissions: serverWritten},
        kind: {type: SchemaTypes.String, required: true, trim: true, maxlength: 32, permissions: serverWritten},
        itemId: {type: SchemaTypes.String, required: true, trim: true, maxlength: 64, permissions: serverWritten},
        section: {type: SchemaTypes.String, required: true, trim: true, maxlength: 32, permissions: serverWritten},
        path: {type: SchemaTypes.String, required: true, maxlength: 1000, permissions: serverWritten},
    },
    {accessMode: "loose"},
);

// Not tenant-scoped: every row is stored in the platform company and every query names its person (like D163).
ownershipPlugin(PortalFavouriteSchema, {tenantScoped: false});
auditPlugin(PortalFavouriteSchema);
softDeletePlugin(PortalFavouriteSchema);
lifeCyclePlugin(PortalFavouriteSchema);
applyPortalFavouriteIndexes(PortalFavouriteSchema);
const PortalFavourite = model<IPortalFavourite>("PortalFavourite", PortalFavouriteSchema);
normalizeSchemaPermissions(PortalFavourite);
export default PortalFavourite;

addModelData(PortalFavourite);
