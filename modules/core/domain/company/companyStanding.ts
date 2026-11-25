/**
 * The platform's two holds on a company (D191), used by the platform's companies page and its report desk alike:
 * hidden from the portal (its own site keeps working), and suspended (nobody signs in or works in it, its sites and
 * portal entries are gone, nothing is mailed or messaged on its behalf). A protected company refuses both.
 *
 * @module domain/company/companyStanding
 */

import type {ClientSession} from "mongoose";
import {ObjectId} from "mongodb";
import {companyService} from "@coreModule/database/schemas/company/company.service";
import type {ICompany} from "@coreModule/database/schemas/company/company";
import {assertCompanyChangeAllowed} from "@coreModule/utilities/security/platformAccess";
import {withTenant} from "@coreModule/utilities/endpoints/tenantScope";
import {runAfterCommit} from "@coreModule/utilities/middlewares/transactionUtils";
import {invalidateCompanyMailCache} from "@coreModule/utilities/emails/mailDeliveryService";
import type {serverLogger} from "@coreModule/loggers/serverLog";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";

export type CompanyStandingContext = {
    /** The platform user who decided. */
    decidedBy: string;
    session?: ClientSession;
    logger: serverLogger;
    languageCode: string;
};

async function loadCompany(companyId: ObjectId, ctx: CompanyStandingContext): Promise<ICompany> {
    const target = await companyService.findById(companyId, {session: ctx.session});
    if (!target) throw apiValidationException("not_found", "", null, ctx.languageCode);
    return target;
}

async function saveCompany(target: ICompany, ctx: CompanyStandingContext): Promise<void> {
    target.$locals = target.$locals || {};
    target.$locals.auditUserId = ctx.decidedBy;
    // Saved in the target's tenant: its public-media plugin touches the target's logo (TD-B188).
    await withTenant(target._id, () => target.save({session: ctx.session}));
}

/** Hides a company from the portal and the shop apex, or shows it again; the platform's override over its own opt-ins. */
export async function setCompanyPortalHidden(companyId: ObjectId, hidden: boolean, ctx: CompanyStandingContext): Promise<ICompany> {
    const target = await loadCompany(companyId, ctx);
    assertCompanyChangeAllowed(target, {hideFromPortal: hidden}, ctx.languageCode);
    target.hiddenFromPortal = hidden;
    await saveCompany(target, ctx);
    ctx.logger.debug(`Company '${target.name}' ${hidden ? "hidden from" : "shown on"} the portal`);
    return target;
}

/**
 * Suspends a company, keeping the platform's reason with it, or lifts the suspension. Its people are refused with
 * `company_suspended`; the reason stays the platform's. The platform company never suspends itself.
 */
export async function setCompanySuspended(
    companyId: ObjectId,
    suspended: boolean,
    ctx: CompanyStandingContext & {reason?: string},
): Promise<ICompany> {
    const target = await loadCompany(companyId, ctx);
    if (suspended && target.isPlatformOwner) throw apiValidationException("company_is_protected", "", null, ctx.languageCode);
    assertCompanyChangeAllowed(target, {suspend: suspended}, ctx.languageCode);
    if (suspended) {
        target.suspendedAt = new Date();
        target.suspendedReason = ctx.reason?.trim() || undefined;
        target.suspendedBy = new ObjectId(ctx.decidedBy);
    } else {
        target.suspendedAt = undefined;
        target.suspendedReason = undefined;
        target.suspendedBy = undefined;
    }
    await saveCompany(target, ctx);
    // Mail on its behalf stops (or starts again) with the next message, not when the cache expires.
    await runAfterCommit(ctx.session, async () => invalidateCompanyMailCache(target._id));
    ctx.logger.info(`Company '${target.name}' ${suspended ? "suspended" : "no longer suspended"} by the platform`);
    return target;
}
