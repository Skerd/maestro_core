import {ObjectId} from "mongodb";
import {action} from "@coreModule/api/actionDecorator";
import type {AuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import type {TransactionRequiredParams} from "@coreModule/utilities/middlewares/transactionUtils";
import {assertPlatformCompany} from "@coreModule/utilities/security/platformAccess";
import {DECIDE_REPORTS_PERMISSION, decideReport, reportDeskCounts, undoReport} from "@coreModule/domain/reports/reportDesk";
import {contentReportToDTO} from "@coreModule/utilities/mappers/contentReport/contentReportMapper.dto";
import {validateSingleForm} from "armonia/src/modules/core/utilities/zod/shared.validator";
import {decideReportSchema, type DecideReportFormType} from "armonia/src/modules/core/api/reports/report.form.validator";
import type {ContentReport, ReportDeskCounts} from "armonia/src/modules/core/api/reports/contentReport.dto";

const READ_RATE_LIMIT = {windowMs: 60000, max: 120};
const DECISION_RATE_LIMIT = {windowMs: 60000, max: 60};

/**
 * The platform's report desk (D191), mounted on the desk's CRUD router: every action is the permission `decideReports`
 * of the platform-only `ContentReport` and runs only in the platform company.
 */
export class ContentReportActions {

    /** How many reports wait: the menu's badge reads it once, then gets it live. */
    @action({auth: "private", rateLimit: READ_RATE_LIMIT, permission: DECIDE_REPORTS_PERMISSION})
    async counts(params: AuthenticatedMWType): Promise<ReportDeskCounts> {
        assertPlatformCompany(params);
        return reportDeskCounts();
    }

    /** Decides an open report, and every other open report of the same thing with it. */
    @action({auth: "private", rateLimit: DECISION_RATE_LIMIT, transaction: true, schema: decideReportSchema, permission: DECIDE_REPORTS_PERMISSION})
    async decide(params: TransactionRequiredParams & DecideReportFormType): Promise<ContentReport> {
        assertPlatformCompany(params);
        const {session, logger, languageCode, actionUserCtx, company} = params;
        const report = await decideReport({
            reportId: new ObjectId(params._id),
            platformId: company._id,
            decision: params.decision,
            note: params.note,
            decidedBy: actionUserCtx.userId,
            session,
            logger,
            languageCode,
        });
        return contentReportToDTO(report, languageCode);
    }

    /** Shows the thing or the company again, or lifts the suspension or the ban, that a decision brought. */
    @action({auth: "private", rateLimit: DECISION_RATE_LIMIT, transaction: true, schema: validateSingleForm, permission: DECIDE_REPORTS_PERMISSION})
    async undo(params: TransactionRequiredParams & {_id: string}): Promise<ContentReport> {
        assertPlatformCompany(params);
        const {session, logger, languageCode, actionUserCtx, company} = params;
        const report = await undoReport({
            reportId: new ObjectId(params._id),
            platformId: company._id,
            decidedBy: actionUserCtx.userId,
            session,
            logger,
            languageCode,
        });
        return contentReportToDTO(report, languageCode);
    }
}
