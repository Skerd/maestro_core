/**
 * The platform's report desk (D191): anyone signed in reports a public thing a module declared reportable
 * (`reportables`), the report is kept in the platform company with what the thing looked like then, and the
 * platform's reviewers decide: dismiss it, hide the thing, hide its company from the portal, suspend the company, or
 * ban the account that wrote it. A decision closes every open report of the same thing; hiding, suspending and
 * banning can be undone.
 *
 * @module domain/reports/reportDesk
 */

import type {ClientSession} from "mongoose";
import {ObjectId} from "mongodb";
import ContentReport, {type IContentReport} from "@coreModule/database/schemas/contentReport/contentReport";
import {contentReportService} from "@coreModule/database/schemas/contentReport/contentReport.service";
import {companyService} from "@coreModule/database/schemas/company/company.service";
import {findReportable, type RegisteredReportable, type ReportableHideContext} from "@coreModule/domain/reports/reportables";
import {setAccountBanned} from "@coreModule/domain/reports/accountBan";
import {setHiddenByPlatform} from "@coreModule/database/plugins/platformHiddenPlugin";
import {setCompanyPortalHidden, setCompanySuspended} from "@coreModule/domain/company/companyStanding";
import {findPlatformCompanyId} from "@coreModule/utilities/security/platformAccess";
import {companyMemberIdsWithPermission} from "@coreModule/domain/roles/companyPermissionHolders";
import {actionPermissionTag} from "@coreModule/utilities/security/actionPermissions";
import {asCrossTenant, withTenant} from "@coreModule/utilities/endpoints/tenantScope";
import {pushWebsocketMessage} from "@coreModule/connections/connectToWebSocketServer";
import {runAfterCommit} from "@coreModule/utilities/middlewares/transactionUtils";
import {getLogger, type serverLogger} from "@coreModule/loggers/serverLog";
import {clientHostFor} from "@coreModule/environment";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {ServerError} from "armonia/src/modules/core/types";
import {REPORT_DESK_COUNTS_CODE, type ReportDeskCounts} from "armonia/src/modules/core/api/reports/contentReport.dto";
import type {ReportDecision, ReportReason} from "armonia/src/modules/core/api/reports/report.form.validator";

/** The permission of the platform's report reviewers: the `decideReports` action of the platform-only `ContentReport`. */
export const DECIDE_REPORTS_PERMISSION = "decideReports";

type DeskContext = {session?: ClientSession; logger: serverLogger; languageCode: string};

/** The platform company and the users there who decide reports; none while there is no platform company. */
async function platformReviewers(): Promise<{platformId: ObjectId; reviewerIds: string[]} | null> {
    const platformId = await findPlatformCompanyId();
    if (!platformId) return null;
    const reviewerIds = await withTenant(platformId, () =>
        companyMemberIdsWithPermission(platformId, actionPermissionTag(ContentReport, DECIDE_REPORTS_PERMISSION, "self")));
    return {platformId, reviewerIds};
}

/** How many reports wait for a decision. */
export async function reportDeskCounts(): Promise<ReportDeskCounts> {
    const platformId = await findPlatformCompanyId();
    if (!platformId) return {open: 0};
    return withTenant(platformId, async () => ({open: await contentReportService.count({company: platformId, status: "open"})}));
}

/**
 * Brings the platform's reviewers the new count (`REPORT_DESK_COUNTS_CODE`), for the menu's badge and an open desk.
 * Best effort: a failure is only logged.
 */
export async function publishReportDeskCounts(logger: serverLogger = getLogger("report_desk")): Promise<void> {
    try {
        const reviewers = await platformReviewers();
        if (!reviewers?.reviewerIds.length) return;
        pushWebsocketMessage({code: REPORT_DESK_COUNTS_CODE, payload: {counts: await reportDeskCounts()}, userIds: reviewers.reviewerIds});
    } catch (error) {
        logger.warn(`Report desk counts not sent: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/** A snapshot's page as the desk links it: a portal path (`/shop/...`) becomes a link on the portal, not the panel. */
function portalUrlOf(url: string | undefined): string | undefined {
    if (!url) return undefined;
    return url.startsWith("/") ? `${clientHostFor("portal")}${url}` : url;
}

function definitionOf(kind: string, languageCode: string): RegisteredReportable {
    const definition = findReportable(kind);
    if (!definition) throw apiValidationException("report_kind_unknown", "", null, languageCode);
    return definition;
}

/**
 * Files a report: the thing is read across companies through its kind's definition and kept as it looks now. One open
 * report per thing and person (`report_already_sent`). The reported company is never told who reported it.
 */
export async function createReport(args: DeskContext & {
    kind: string;
    recordId: ObjectId;
    reason: ReportReason;
    comment?: string;
    reporterId: string;
    reporterEmail: string;
}): Promise<void> {
    const {session, logger, languageCode} = args;
    const definition = definitionOf(args.kind, languageCode);
    const platformId = await findPlatformCompanyId();
    if (!platformId) throw apiValidationException("report_desk_unavailable", "", null, languageCode);
    const snapshot = await asCrossTenant("a report reads the reported thing in whichever company owns it (D191)",
        () => definition.snapshot({recordId: args.recordId, session, logger, languageCode}));
    if (!snapshot) throw apiValidationException("report_record_not_found", "", null, languageCode);
    // Your own review, job or quote is yours to change or withdraw, not to report.
    if (snapshot.authorAccountId?.equals(args.reporterId)) throw apiValidationException("report_own_record", "", null, languageCode);
    const owner = await companyService.findById(snapshot.companyId, {session}, undefined, "name");
    const reporter = new ObjectId(args.reporterId);
    await withTenant(platformId, async () => {
        const open = {company: platformId, kind: args.kind, recordId: args.recordId, reporter, status: "open"};
        if (await contentReportService.findOne(open, {session}, undefined, "_id")) {
            throw apiValidationException("report_already_sent", "", null, languageCode);
        }
        try {
            await contentReportService.create({
                company: platformId,
                kind: args.kind,
                recordId: args.recordId,
                recordCompany: snapshot.companyId,
                recordCompanyName: owner?.name ?? "",
                recordTitle: snapshot.title.slice(0, 512) || args.kind,
                recordUrl: portalUrlOf(snapshot.url),
                authorAccount: snapshot.authorAccountId,
                reason: args.reason,
                comment: args.comment?.trim() || undefined,
                reporter,
                reporterEmail: args.reporterEmail,
                status: "open",
            }, {session, logger, languageCode, auditUserId: args.reporterId});
        } catch (error) {
            // Two clicks at once: the unique open-report index keeps one.
            if (error instanceof ServerError && error.error_code === "contentReport_already_exists") {
                throw apiValidationException("report_already_sent", "", null, languageCode);
            }
            throw error;
        }
    });
    await runAfterCommit(session, () => publishReportDeskCounts(logger));
    logger.info(`Report on ${args.kind} ${args.recordId.toString()} filed (${args.reason})`);
}

/**
 * Hides one reported record from the public, or shows it again, as its kind says: a model with platformHiddenPlugin
 * is saved by core in the company that keeps it, then the kind's `onHidden` runs there; any other kind hides itself in
 * the company the report named (`recordCompany`).
 */
export async function setReportableHidden(definition: RegisteredReportable, recordCompany: ObjectId, ctx: ReportableHideContext): Promise<void> {
    if (definition.model) {
        const companyId = await setHiddenByPlatform(definition.model, ctx.recordId, ctx.hidden, {decidedBy: ctx.decidedBy, session: ctx.session, module: definition.module});
        const onHidden = definition.onHidden;
        if (companyId && onHidden) await withTenant(companyId, () => onHidden({...ctx, companyId}), definition.module);
        return;
    }
    await withTenant(recordCompany, () => definition.setHidden(ctx), definition.module);
}

/** Applies a decision's effect, or reverses it (`undo`). */
async function applyDecision(report: IContentReport, decision: ReportDecision, undo: boolean, args: DeskContext & {decidedBy: string; note?: string}): Promise<void> {
    const ctx = {decidedBy: args.decidedBy, session: args.session, logger: args.logger, languageCode: args.languageCode};
    switch (decision) {
        case "dismissed":
            return;
        case "itemHidden":
            await setReportableHidden(definitionOf(report.kind, args.languageCode), report.recordCompany, {
                recordId: report.recordId,
                hidden: !undo,
                decidedBy: new ObjectId(args.decidedBy),
                session: args.session,
                logger: args.logger,
                languageCode: args.languageCode,
            });
            return;
        case "companyHidden":
            await setCompanyPortalHidden(report.recordCompany, !undo, ctx);
            return;
        case "companySuspended":
            await setCompanySuspended(report.recordCompany, !undo, {...ctx, reason: args.note});
            return;
        case "accountBanned":
            if (!report.authorAccount) throw apiValidationException("report_no_author", "", null, args.languageCode);
            await setAccountBanned(report.authorAccount, !undo, {...ctx, reason: args.note});
            return;
    }
}

/** The platform's report in the session's (the platform's) company, or `not_found`. */
async function loadReport(reportId: ObjectId, platformId: ObjectId, args: DeskContext): Promise<IContentReport> {
    const report = await contentReportService.findOne({_id: reportId, company: platformId}, {session: args.session});
    if (!report) throw apiValidationException("not_found", "", null, args.languageCode);
    return report;
}

/** Decides an open report; the same decision closes every other open report of the same thing. */
export async function decideReport(args: DeskContext & {
    reportId: ObjectId;
    platformId: ObjectId;
    decision: ReportDecision;
    note?: string;
    decidedBy: string;
}): Promise<IContentReport> {
    const report = await loadReport(args.reportId, args.platformId, args);
    if (report.status !== "open") throw apiValidationException("report_not_open", "", null, args.languageCode);
    if (args.decision === "accountBanned" && !report.authorAccount) {
        throw apiValidationException("report_no_author", "", null, args.languageCode);
    }
    await applyDecision(report, args.decision, false, args);
    const note = args.note?.trim() || undefined;
    await contentReportService.updateMany(
        {company: args.platformId, kind: report.kind, recordId: report.recordId, status: "open"},
        {$set: {status: "closed", decision: args.decision, decisionNote: note, decidedBy: new ObjectId(args.decidedBy), decidedAt: new Date()}},
        {session: args.session, logger: args.logger},
    );
    await runAfterCommit(args.session, () => publishReportDeskCounts(args.logger));
    args.logger.info(`Report ${report._id.toString()} on ${report.kind} decided: ${args.decision}`);
    return loadReport(args.reportId, args.platformId, args);
}

/**
 * Undoes a decision that changed something (the thing or company shown again, the suspension or ban lifted), on every
 * report the decision closed. A dismissal has nothing to undo (`report_cannot_undo`).
 */
export async function undoReport(args: DeskContext & {reportId: ObjectId; platformId: ObjectId; decidedBy: string}): Promise<IContentReport> {
    const report = await loadReport(args.reportId, args.platformId, args);
    if (report.status !== "closed" || !report.decision || report.decision === "dismissed" || report.undoneAt || !report.decidedAt) {
        throw apiValidationException("report_cannot_undo", "", null, args.languageCode);
    }
    await applyDecision(report, report.decision, true, args);
    await contentReportService.updateMany(
        {company: args.platformId, kind: report.kind, recordId: report.recordId, decidedAt: report.decidedAt, undoneAt: null},
        {$set: {undoneAt: new Date(), undoneBy: new ObjectId(args.decidedBy)}},
        {session: args.session, logger: args.logger},
    );
    args.logger.info(`Report ${report._id.toString()} decision ${report.decision} undone`);
    return loadReport(args.reportId, args.platformId, args);
}
