import type {ClientSession} from "mongoose";
import type {ObjectId} from "mongodb";
import {emitNotificationEvent, NotificationEventCodes} from "@coreModule/domain/notifications/notificationEventBus";
import {companyMemberIdsWithPermission} from "@coreModule/domain/roles/companyPermissionHolders";
import {findPlatformCompanyId} from "@coreModule/utilities/security/platformAccess";
import {withTenant} from "@coreModule/utilities/endpoints/tenantScope";

/**
 * Notices of self-serve business sign-up (D178), sent after the request's transaction commits: the platform's admins
 * hear of a new company waiting for approval, the company's admins hear the platform's decision.
 */

type NoticeContext = {languageCode: string; session?: ClientSession};

/** The company a notice is about. */
type NoticeCompany = {_id: ObjectId; name: string};

/** Each company's admins, read in its own tenant (roles are tenant data). */
function adminIdsOf(companyId: ObjectId): Promise<string[]> {
    return withTenant(companyId, () => companyMemberIdsWithPermission(companyId, undefined));
}

/** Tells the platform's admins that `company` signed up and waits for their approval to be listed. */
export async function notifyCompanySignedUp(company: NoticeCompany, ctx: NoticeContext): Promise<void> {
    const platformId = await findPlatformCompanyId();
    if (!platformId) return;
    const receiverIds = await adminIdsOf(platformId);
    if (receiverIds.length === 0) return;
    emitNotificationEvent(NotificationEventCodes.COMPANY_SIGNED_UP, {
        receiverIds,
        payload: {companyId: platformId.toString(), subjectCompanyId: String(company._id), name: company.name, languageCode: ctx.languageCode},
        session: ctx.session,
    });
}

/** Tells `company`'s admins whether the platform lists it on the portal apex, with the reason of a rejection. */
export async function notifyPortalApprovalDecided(
    company: NoticeCompany,
    decision: {status: "approved" | "rejected"; reason?: string},
    ctx: NoticeContext,
): Promise<void> {
    const receiverIds = await adminIdsOf(company._id);
    if (receiverIds.length === 0) return;
    const rejected = decision.status === "rejected";
    emitNotificationEvent(rejected ? NotificationEventCodes.COMPANY_PORTAL_REJECTED : NotificationEventCodes.COMPANY_PORTAL_APPROVED, {
        receiverIds,
        payload: {
            companyId: String(company._id),
            subjectCompanyId: String(company._id),
            name: company.name,
            ...(rejected && decision.reason ? {reason: decision.reason, variant: "withReason"} : {}),
            languageCode: ctx.languageCode,
        },
        session: ctx.session,
    });
}
