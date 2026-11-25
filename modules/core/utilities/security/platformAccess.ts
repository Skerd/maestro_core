/**
 * Platform-wide access: rights that exist only while the session acts in the
 * platform-owner company (`Company.isPlatformOwner`). There is no global
 * super-admin; switching to another company drops these rights.
 *
 * @module utilities/security/platformAccess
 */

import type {ObjectId} from "mongodb";
import {ICompany} from "@coreModule/database/schemas/company/company";
import {companyService} from "@coreModule/database/schemas/company/company.service";
import {AuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {UNUSABLE_REQUEST_STATUSES} from "@coreModule/database/plugins/requestablePlugin";

type PlatformAccessParams = Pick<AuthenticatedMWType, "company" | "actionUserCtx" | "languageCode">;

export function isPlatformCompany(company: Pick<ICompany, "isPlatformOwner"> | null | undefined): boolean {
    return company?.isPlatformOwner === true;
}

/** Server-wide data (performance, health) is only shown inside the platform company. */
export function assertPlatformCompany(params: PlatformAccessParams): void {
    if (!isPlatformCompany(params.company)) {
        throw apiValidationException("platform_company_required", "", null, params.languageCode);
    }
}

/** The active platform-owner company's id, or undefined while there is none. */
export async function findPlatformCompanyId(): Promise<ObjectId | undefined> {
    const company = await companyService.findOne({isPlatformOwner: true, isActive: true}, {}, null, "_id");
    return company?._id;
}

/**
 * The rows of a platform list (D160) a record may use: the platform company's, except entries still waiting for the
 * platform's approval or turned down (requestablePlugin). Matches nothing while there is no platform company, so no other company's
 * leftover rows ever show.
 */
export async function platformRowsClause(): Promise<Record<string, unknown>> {
    const platformId = await findPlatformCompanyId();
    return platformId ? {company: platformId, requestStatus: {$nin: UNUSABLE_REQUEST_STATUSES}} : {_id: {$exists: false}};
}

/**
 * The rows of a platform list a session company sees in the list page: the platform sees every row, requests included;
 * another company sees the approved rows and the entries it requested itself (pending, rejected or withdrawn).
 */
export async function platformListClause(company: Pick<ICompany, "_id" | "isPlatformOwner">): Promise<Record<string, unknown>> {
    const platformId = await findPlatformCompanyId();
    if (!platformId) return {_id: {$exists: false}};
    if (isPlatformCompany(company)) return {company: platformId};
    return {company: platformId, $or: [{requestStatus: {$nin: UNUSABLE_REQUEST_STATUSES}}, {requestedByCompany: company._id}]};
}

/** Managing other companies needs an admin of the platform company. */
export function assertPlatformAdmin(params: PlatformAccessParams): void {
    if (!isPlatformCompany(params.company) || !params.actionUserCtx.isAdmin) {
        throw apiValidationException("platform_admin_required", "", null, params.languageCode);
    }
}

/**
 * A protected company (the platform owner, the marketplace operator) keeps running: it is never deactivated, suspended,
 * hidden from the portal or left without a module it has. `removedModules` are the grants the change would drop.
 */
export function assertCompanyChangeAllowed(
    company: Pick<ICompany, "isProtected">,
    change: {deactivate?: boolean; suspend?: boolean; hideFromPortal?: boolean; removedModules?: string[]},
    languageCode: string,
): void {
    if (company.isProtected !== true) return;
    if (change.deactivate || change.suspend || change.hideFromPortal || (change.removedModules?.length ?? 0) > 0) {
        throw apiValidationException("company_is_protected", "", null, languageCode);
    }
}
