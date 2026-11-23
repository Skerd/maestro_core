import {ObjectId} from "mongodb";
import {BaseCrudService} from "@coreModule/database/services/baseCrudService";
import type {CrudOptions} from "@coreModule/database/services/baseCrudService";
import {findPlatformCompanyId} from "@coreModule/utilities/security/platformAccess";
import PortalSavedSearch, {IPortalSavedSearch} from "@coreModule/database/schemas/portalSavedSearch/portalSavedSearch";

/** Saved searches one alert run reads at most; the rest wait for the next day. */
const ALERT_RUN_MAX = 5000;

export class PortalSavedSearchService extends BaseCrudService<IPortalSavedSearch, typeof PortalSavedSearch> {
    constructor() {
        super(PortalSavedSearch, "PortalSavedSearch");
    }

    /**
     * A person's saved searches (P23.7), stored in the platform company like the address book (D163). Matches nothing
     * while there is no platform company.
     */
    async ownClause(userId: ObjectId | string): Promise<Record<string, unknown>> {
        const platformId = await findPlatformCompanyId();
        if (!platformId) return {_id: {$exists: false}};
        return {company: platformId, user: new ObjectId(String(userId)), deletedAt: null};
    }

    async findOwn(userId: ObjectId | string, options: CrudOptions = {}): Promise<IPortalSavedSearch[]> {
        return this.find(await this.ownClause(userId), {...options, withDeleted: false}, undefined, undefined, {createdAt: -1, _id: -1});
    }

    /** The searches stored in `companyId` whose alert is on, the longest-waiting first, grouped by person by the caller. */
    async findAlerting(companyId: ObjectId, options: CrudOptions = {}): Promise<IPortalSavedSearch[]> {
        return this.find({company: companyId, alerts: true, deletedAt: null}, {...options, withDeleted: false}, undefined, undefined, {lastAlertAt: 1, _id: 1}, ALERT_RUN_MAX);
    }
}

export const portalSavedSearchService = new PortalSavedSearchService();
