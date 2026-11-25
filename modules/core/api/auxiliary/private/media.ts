import {Request, Response, Router} from 'express';
import {asyncHandler} from '@coreModule/utilities/middlewares/asyncHandler';
import {getLogger} from '@coreModule/loggers/serverLog';
import {getMediaInfo, isHeldForReview, serveMedia, type ServeMediaAccessCheck} from "@coreModule/utilities/media/serveMedia";
import type {IMedia} from "@coreModule/database/schemas/media/media";
import authMW, {AuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import authMediaMW from "@coreModule/utilities/middlewares/authMediaMW";
import {rateLimiter} from "@coreModule/utilities/middlewares/rateLimiter";
import {mediaUploadMW} from "@coreModule/utilities/middlewares/mediaUploadMW";
import {asCrossTenant} from "@coreModule/utilities/endpoints/tenantScope";
import UploadRefusal from "@coreModule/database/schemas/uploadRefusal/uploadRefusal";
import {REVIEW_UPLOADS_PERMISSION} from "@coreModule/domain/uploadReview/uploadReview";
import {actionPermissionMW} from "@coreModule/utilities/security/actionPermissions";
import {assertPlatformCompany, isPlatformCompany} from "@coreModule/utilities/security/platformAccess";
import type {ICompany} from "@coreModule/database/schemas/company/company";
import {nestedEntityToRef} from "@coreModule/utilities/mappers/common.mapper";
import {ServerError} from "armonia/src/modules/core/types";

const router = Router();

/**
 * The session's company owns the file, or the owner shared it with that company. The platform company is different:
 * its members are portal accounts that do not know each other, so a file it holds that is not public opens only for
 * the person who uploaded it (a patient's X-rays sent to clinics, D189); the companies it was shared with still open it.
 */
function companyOwnsMedia(
    _mediaId: unknown,
    media: Pick<IMedia, "company" | "sharedWithCompanies" | "isPublic" | "createdBy">,
    context: Record<string, unknown>,
): Promise<boolean> {
    const company = context.company as Pick<ICompany, "_id" | "isPlatformOwner"> | undefined;
    const sessionCompany = String(company?._id ?? "");
    const mediaCompany = String(nestedEntityToRef(media.company) ?? "");
    if (sessionCompany === "") return Promise.resolve(false);
    if (sessionCompany !== mediaCompany) return Promise.resolve((media.sharedWithCompanies ?? []).map(String).includes(sessionCompany));
    if (!isPlatformCompany(company) || media.isPublic === true) return Promise.resolve(true);
    return Promise.resolve(String(nestedEntityToRef(media.createdBy) ?? "") === context.userId);
}

/** Another company's file the portal would serve: public, and not held by the content check (D177). */
function isPublicMedia(_mediaId: unknown, media: {isPublic?: boolean} & Pick<IMedia, "metadata">): Promise<boolean> {
    return Promise.resolve(media.isPublic === true && !isHeldForReview(media));
}

/**
 * Serves the session company's own or shared file; when the tenant has no such file, another company's file only if it
 * is public (e.g. a company's logo in the platform's company list or the company switcher) — the same files the portal
 * serves to anyone. Any other company's file stays `media_not_found`.
 */
async function ownOrPublicMedia<T>(serveOwn: () => Promise<T>, servePublic: () => Promise<T>): Promise<T> {
    try {
        return await serveOwn();
    } catch (error) {
        if (!(error instanceof ServerError && error.error_code === "media_not_found")) throw error;
        return asCrossTenant("a signed-in user sees other companies' public media, such as their logos", servePublic);
    }
}

/**
 * @route   GET /api/auxiliary/media/:mediaId/info
 * @desc    MIME / name / size for preview classification (no binary)
 */
router.get(
    "/:mediaId/info",
    authMediaMW,
    rateLimiter({windowMs: 60000, max: 120}),
    asyncHandler(serveMediaInfo)
);

/**
 * @route   GET /api/auxiliary/media/:mediaId
 * @desc    Tenant media stream (session cookie or x-auth-token)
 */
router.get(
    "/:mediaId",
    authMediaMW,
    rateLimiter({windowMs: 60000, max: 120}),
    asyncHandler(serveMediaFile)
);

/**
 * @route   GET /api/auxiliary/media/review/:mediaId
 * @desc    A file under the platform's upload review (D177): any company's, never a health file, blurred or held like
 *          any flagged file until the reviewer asks for it (`?reveal=1`). Platform company with `reviewUploads` only.
 */
router.get(
    "/review/:mediaId",
    authMediaMW,
    actionPermissionMW(UploadRefusal, REVIEW_UPLOADS_PERMISSION),
    rateLimiter({windowMs: 60000, max: 240}),
    asyncHandler(serveReviewedFile),
);

router.post(
    "/upload-batch",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 30}),
    // The ids go into a form submitted afterwards; unused ones are swept by `core.orphanUploadCleanup`.
    mediaUploadMW({fieldName: "files", maxFiles: 50, maxFileSize: 100 * 1024 * 1024, markPendingReference: true}),
    asyncHandler(uploadBatch),
);

async function serveMediaInfo(_params: AuthenticatedMWType, queryParams: any, req: Request) {
    const logger = getLogger("serve_media_info");
    const languageCode = req.header("language") || "en-US";
    const info = (accessCheck: ServeMediaAccessCheck, deniedAsNotFound: boolean) => () => getMediaInfo({
        mediaId: queryParams.mediaId,
        logger,
        languageCode,
        accessCheck,
        context: {company: _params.company, userId: _params.actionUserCtx.userId},
        deniedAsNotFound,
    });
    // A refused file answers like one that does not exist, so a stranger cannot learn it is there (D189)
    return ownOrPublicMedia(info(companyOwnsMedia, true), info(isPublicMedia, true));
}

async function serveMediaFile(params: AuthenticatedMWType, queryParams: any, req: Request, res: Response) {
    const logger = getLogger("serve_media_file");
    const languageCode = req.header("language") || "en-US";
    const serve = (accessCheck: ServeMediaAccessCheck, deniedAsNotFound: boolean) => () => serveMedia({
        mediaId: queryParams.mediaId,
        req,
        res,
        logger,
        languageCode,
        cacheControl: "private",
        accessCheck,
        context: {company: params.company, userId: params.actionUserCtx.userId},
        deniedAsNotFound,
        blurHeldForReview: true,
    });
    return ownOrPublicMedia(serve(companyOwnsMedia, true), serve(isPublicMedia, true));
}

/** A file under review: any company's, never a health file (only its own company may open those, D102). */
function underReview(_mediaId: unknown, media: Pick<IMedia, "encrypted" | "metadata">): Promise<boolean> {
    const status = media.metadata?.moderation?.status;
    return Promise.resolve(media.encrypted !== true && (status === "flagged" || status === "rejected" || status === "approved"));
}

async function serveReviewedFile(params: AuthenticatedMWType, queryParams: {mediaId: string}, req: Request, res: Response) {
    assertPlatformCompany(params);
    const languageCode = req.header("language") || "en-US";
    return asCrossTenant("the platform reviews any company's flagged upload (D177)", () => serveMedia({
        mediaId: queryParams.mediaId,
        req,
        res,
        logger: getLogger("upload_review_file"),
        languageCode,
        cacheControl: "private",
        accessCheck: underReview,
        deniedAsNotFound: true,
        blurHeldForReview: true,
    }));
}

async function uploadBatch(params: any): Promise<{ids: string[]}> {
    return {ids: params.fileIds ?? []};
}

export { router };
