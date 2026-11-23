import {ObjectId} from "mongodb";
import {BaseCrudService} from "@coreModule/database/services/baseCrudService";
import type {CrudOptions} from "@coreModule/database/services/baseCrudService";
import {findPlatformCompanyId} from "@coreModule/utilities/security/platformAccess";
import PortalFavourite, {IPortalFavourite} from "@coreModule/database/schemas/portalFavourite/portalFavourite";

export class PortalFavouriteService extends BaseCrudService<IPortalFavourite, typeof PortalFavourite> {
    constructor() {
        super(PortalFavourite, "PortalFavourite");
    }

    /**
     * A person's kept items (P23.7), stored in the platform company like the address book (D163). Matches nothing while
     * there is no platform company.
     */
    async ownClause(userId: ObjectId | string): Promise<Record<string, unknown>> {
        const platformId = await findPlatformCompanyId();
        if (!platformId) return {_id: {$exists: false}};
        return {company: platformId, user: new ObjectId(String(userId)), deletedAt: null};
    }

    /** The person's kept items, newest first. */
    async findOwn(userId: ObjectId | string, options: CrudOptions = {}): Promise<IPortalFavourite[]> {
        return this.find(await this.ownClause(userId), {...options, withDeleted: false}, undefined, "kind itemId section path createdAt", {createdAt: -1, _id: -1});
    }
}

export const portalFavouriteService = new PortalFavouriteService();
