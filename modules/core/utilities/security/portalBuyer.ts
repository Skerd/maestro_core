/**
 * Portal buyers and the module gate (D143, TD-B189). A portal account belongs to the platform company, which does not
 * run the verticals it sells: the module a buyer route needs is checked on the company the buyer's record lives in
 * (the seller of an order), never on the buyer's own company. What spans every company (a buyer's orders from every
 * seller, the portal's jobs, D197) names the platform company, which answers for any module the server runs.
 *
 * @module utilities/security/portalBuyer
 */

import {ObjectId} from "mongodb";
import {companyService} from "@coreModule/database/schemas/company/company.service";
import {isModuleEnabledForCompany} from "@coreModule/utilities/modules/companyModules";
import {getEnabledModuleNames} from "@coreModule/utilities/modules/enabledModules";
import {isPlatformCompany} from "@coreModule/utilities/security/platformAccess";
import {isPortalZoneOrigin} from "@coreModule/utilities/marketing/portalOrigin";

/** What a portal buyer route knows about its request before validation: the raw body and the route params. */
export type PortalBuyerRequest = {body: Record<string, unknown>; params: Record<string, string>};

/**
 * Names the company the request's record lives in, or nothing when the request names none it can find (the route
 * is then refused). It reads across companies itself, with its reason, since the buyer is not a member there.
 */
export type PortalBuyerTarget = (request: PortalBuyerRequest) => Promise<ObjectId | string | null | undefined>;

/**
 * True when a portal-zone request's target company is active and has `moduleName`, or is the platform company while
 * the server runs `moduleName` (D197). Requests from anywhere else, and routes that declare no target, keep the session
 * company's gate.
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
    const company = await companyService.findById(new ObjectId(String(companyId)), {}, [], "isActive modules isPlatformOwner");
    if (!company || company.isActive !== true) return false;
    return isModuleEnabledForCompany(company, moduleName) || (isPlatformCompany(company) && getEnabledModuleNames().includes(moduleName));
}
