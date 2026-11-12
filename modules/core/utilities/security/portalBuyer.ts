/**
 * Portal buyers and the module gate (D143, TD-B189). A portal account belongs to the platform company, which does not
 * run the verticals it sells: the module a buyer route needs is checked on the company the buyer's record lives in
 * (the seller of an order, the marketplace operator of a job), never on the buyer's own company.
 *
 * @module utilities/security/portalBuyer
 */

import {ObjectId} from "mongodb";
import {companyService} from "@coreModule/database/schemas/company/company.service";
import {isModuleEnabledForCompany} from "@coreModule/utilities/modules/companyModules";
import {isPortalZoneOrigin} from "@coreModule/utilities/marketing/portalOrigin";

/** What a portal buyer route knows about its request before validation: the raw body and the route params. */
export type PortalBuyerRequest = {body: Record<string, unknown>; params: Record<string, string>};

/**
 * Names the company the request's record lives in, or nothing when the request names none it can find (the route
 * is then refused). It reads across companies itself, with its reason, since the buyer is not a member there.
 */
export type PortalBuyerTarget = (request: PortalBuyerRequest) => Promise<ObjectId | string | null | undefined>;

/**
 * True when a portal-zone request's target company is active and has `moduleName`. Requests from anywhere else, and
 * routes that declare no target, keep the session company's gate.
 */
export async function portalBuyerTargetHasModule(
    target: PortalBuyerTarget | undefined,
    request: PortalBuyerRequest,
    origin: string,
    moduleName: string,
): Promise<boolean> {
    if (!target || !isPortalZoneOrigin(origin)) return false;
    const companyId = await target(request);
    if (!companyId || !ObjectId.isValid(String(companyId))) return false;
    const company = await companyService.findById(new ObjectId(String(companyId)), {}, [], "isActive modules");
    return !!company && company.isActive === true && isModuleEnabledForCompany(company, moduleName);
}
