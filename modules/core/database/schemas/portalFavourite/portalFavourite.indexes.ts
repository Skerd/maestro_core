import {Schema} from "mongoose";

export function applyPortalFavouriteIndexes(PortalFavouriteSchema: Schema): void {
    // A person's list, newest first, and the one row of an item.
    PortalFavouriteSchema.index({company: 1, user: 1, createdAt: -1});
    PortalFavouriteSchema.index({company: 1, user: 1, kind: 1, itemId: 1});
}
