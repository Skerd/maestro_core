import {ObjectId} from "mongodb";
import {action} from "@coreModule/api/actionDecorator";
import type {AuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import type {TransactionRequiredParams} from "@coreModule/utilities/middlewares/transactionUtils";
import {asCrossTenant} from "@coreModule/utilities/endpoints/tenantScope";
import {assertPlatformCompany} from "@coreModule/utilities/security/platformAccess";
import {decideUploadReview, listUploadReview, REVIEW_UPLOADS_PERMISSION, uploadReviewCounts, uploadReviewItem} from "@coreModule/domain/uploadReview/uploadReview";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {validateSingleForm} from "armonia/src/modules/core/utilities/zod/shared.validator";
import {uploadReviewListFormSchema} from "armonia/src/modules/core/api/auxiliary/private/uploadReview/uploadReview.form.validator";
import type {
    UploadReviewCounts,
    UploadReviewItem,
    UploadReviewListResponse,
    UploadReviewView,
} from "armonia/src/modules/core/api/auxiliary/private/uploadReview/uploadReview.dto";

const DEFAULT_LIMIT = 24;
const READ_RATE_LIMIT = {windowMs: 60000, max: 120};
const DECISION_RATE_LIMIT = {windowMs: 60000, max: 60};

type DecisionParams = TransactionRequiredParams & {_id: string};

function decide(params: DecisionParams, decision: "approved" | "rejected"): Promise<UploadReviewItem> {
    assertPlatformCompany(params);
    const {_id, session, logger, languageCode, actionUserCtx} = params;
    return asCrossTenant("the platform decides any company's flagged upload (D177)", () => decideUploadReview({
        mediaId: new ObjectId(_id),
        decision,
        reviewerId: actionUserCtx.userId,
        languageCode,
        session,
        logger,
        notOpen: () => apiValidationException("upload_review_not_open", null, null, languageCode),
        notFound: () => apiValidationException("media_not_found", null, null, languageCode),
    }));
}

/**
 * The platform's upload review (D177), mounted on the review router: every action is the permission `reviewUploads`
 * of the platform-only `UploadRefusal` model and runs only in the platform company, over every company's files except
 * health files.
 */
export class UploadReviewActions {

    /** One page of one list: waiting (`flagged`), removed (`rejected`), approved, or refused uploads. */
    @action({auth: "private", rateLimit: READ_RATE_LIMIT, schema: uploadReviewListFormSchema, permission: REVIEW_UPLOADS_PERMISSION})
    async list(params: AuthenticatedMWType & {view: UploadReviewView; page?: number; limit?: number}): Promise<UploadReviewListResponse> {
        assertPlatformCompany(params);
        const page = params.page ?? 1;
        const limit = params.limit ?? DEFAULT_LIMIT;
        return asCrossTenant("the platform reviews every company's flagged uploads (D177)", () => listUploadReview(params.view, page, limit));
    }

    /** One file under review, for its sheet opened from a notice (`?open=`). */
    @action({auth: "private", rateLimit: READ_RATE_LIMIT, schema: validateSingleForm, permission: REVIEW_UPLOADS_PERMISSION})
    async single(params: AuthenticatedMWType & {_id: string}): Promise<UploadReviewItem> {
        assertPlatformCompany(params);
        const item = await asCrossTenant("the platform reviews any company's flagged upload (D177)", () => uploadReviewItem(new ObjectId(params._id)));
        if (!item) throw apiValidationException("media_not_found", null, null, params.languageCode);
        return item;
    }

    /** How many files each list holds: the menu's badge reads the waiting count once, then gets it live. */
    @action({auth: "private", rateLimit: READ_RATE_LIMIT, permission: REVIEW_UPLOADS_PERMISSION})
    async counts(params: AuthenticatedMWType): Promise<UploadReviewCounts> {
        assertPlatformCompany(params);
        return uploadReviewCounts();
    }

    /** Shows the file as any other: the blur and the hold from visitors are lifted. */
    @action({auth: "private", rateLimit: DECISION_RATE_LIMIT, transaction: true, schema: validateSingleForm, permission: REVIEW_UPLOADS_PERMISSION})
    async approve(params: DecisionParams): Promise<UploadReviewItem> {
        return decide(params, "approved");
    }

    /** Keeps the file, blurred for its company's staff and never sent to visitors. */
    @action({auth: "private", rateLimit: DECISION_RATE_LIMIT, transaction: true, schema: validateSingleForm, permission: REVIEW_UPLOADS_PERMISSION})
    async remove(params: DecisionParams): Promise<UploadReviewItem> {
        return decide(params, "rejected");
    }
}
