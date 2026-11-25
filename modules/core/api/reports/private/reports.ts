/**
 * Reporting a public thing to the platform (D191), for anyone signed in, on the panel or the portal:
 * - POST "" — files a report on one thing a module declared reportable (`kind`, `recordId`), with a reason.
 *
 * Self-service: the report is the caller's own, filed under their account; there is no role permission to hold. The
 * platform decides reports on its desk (`/api/reports/desk`).
 *
 * @module api/reports/private/reports
 */

import {Router} from "express";
import {ObjectId} from "mongodb";
import {asyncHandler} from "@coreModule/utilities/middlewares/asyncHandler";
import authMW from "@coreModule/utilities/middlewares/authMW";
import {rateLimiter} from "@coreModule/utilities/middlewares/rateLimiter";
import {transactionHandler} from "@coreModule/utilities/middlewares/transactionHandler";
import type {TransactionRequiredParams} from "@coreModule/utilities/middlewares/transactionUtils";
import {validateFormZod} from "@coreModule/utilities/middlewares/validateFormZod";
import {createReport} from "@coreModule/domain/reports/reportDesk";
import {createReportSchema, type CreateReportFormType} from "armonia/src/modules/core/api/reports/report.form.validator";

export const basePath = "/api/reports";

const router = Router();

/**
 * POST /api/reports
 *
 * @returns {Promise<{sent: true}>} once the report is kept; `report_already_sent` when this person's earlier report on
 *          the same thing is still open
 */
router.post(
    "/",
    authMW("private"),
    // Few per person: a report is a deliberate act, and a burst is someone flooding the desk.
    rateLimiter({windowMs: 60 * 60 * 1000, max: 20}),
    transactionHandler(),
    validateFormZod(createReportSchema),
    asyncHandler(sendReport),
);

async function sendReport(params: TransactionRequiredParams & CreateReportFormType): Promise<{sent: true}> {
    const {logger, languageCode, session, actionUserCtx, userInfo} = params;
    await createReport({
        kind: params.kind,
        recordId: new ObjectId(params.recordId),
        reason: params.reason,
        comment: params.comment,
        reporterId: actionUserCtx.userId,
        // The sign-in name is the account's email.
        reporterEmail: userInfo.username,
        session,
        logger,
        languageCode,
    });
    return {sent: true};
}

export {router};
