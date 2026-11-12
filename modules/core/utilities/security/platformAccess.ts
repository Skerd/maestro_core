/**
 * Platform-wide access: rights that exist only while the session acts in the
 * platform-owner company (`Company.isPlatformOwner`). There is no global
 * super-admin; switching to another company drops these rights.
 *
 * @module utilities/security/platformAccess
 */

import {ICompany} from "@coreModule/database/schemas/company/company";
import {AuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";

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

/** Managing other companies needs an admin of the platform company. */
export function assertPlatformAdmin(params: PlatformAccessParams): void {
    if (!isPlatformCompany(params.company) || !params.actionUserCtx.isAdmin) {
        throw apiValidationException("platform_admin_required", "", null, params.languageCode);
    }
}

/**
 * A protected company (the platform owner, the marketplace operator) keeps running: it is never deactivated, hidden
 * from the portal or left without a module it has. `removedModules` are the grants the change would drop.
 */
export function assertCompanyChangeAllowed(
    company: Pick<ICompany, "isProtected">,
    change: {deactivate?: boolean; hideFromPortal?: boolean; removedModules?: string[]},
    languageCode: string,
): void {
    if (company.isProtected !== true) return;
    if (change.deactivate || change.hideFromPortal || (change.removedModules?.length ?? 0) > 0) {
        throw apiValidationException("company_is_protected", "", null, languageCode);
    }
}
