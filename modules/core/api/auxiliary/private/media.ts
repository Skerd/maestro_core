import {Request, Response, Router} from 'express';
import {asyncHandler} from '@coreModule/utilities/middlewares/asyncHandler';
import {getLogger} from '@coreModule/loggers/serverLog';
import {getMediaInfo, serveMedia} from "@coreModule/utilities/media/serveMedia";
import authMW, {AuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import authMediaMW from "@coreModule/utilities/middlewares/authMediaMW";
import {rateLimiter} from "@coreModule/utilities/middlewares/rateLimiter";
import {mediaUploadMW} from "@coreModule/utilities/middlewares/mediaUploadMW";

const router = Router();

function companyOwnsMedia(_mediaId: unknown, media: {company?: {_id?: unknown} | unknown}, context: Record<string, unknown>): Promise<boolean> {
    const company = context.company as {_id?: unknown} | undefined;
    const sessionCompany = String(company?._id ?? "");
    const mediaCompany = String((media.company as {_id?: unknown})?._id ?? media.company ?? "");
    return Promise.resolve(sessionCompany !== "" && sessionCompany === mediaCompany);
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

router.post(
    "/upload-batch",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 30}),
    mediaUploadMW({fieldName: "files", maxFiles: 50, maxFileSize: 100 * 1024 * 1024}),
    asyncHandler(uploadBatch),
);

async function serveMediaInfo(_params: AuthenticatedMWType, queryParams: any, req: Request) {
    const logger = getLogger("serve_media_info");
    const languageCode = req.header("language") || "en-US";
    return getMediaInfo({
        mediaId: queryParams.mediaId,
        logger,
        languageCode,
        accessCheck: companyOwnsMedia,
        context: {company: _params.company},
    });
}

async function serveMediaFile(params: AuthenticatedMWType, queryParams: any, req: Request, res: Response) {
    const logger = getLogger("serve_media_file");
    const languageCode = req.header("language") || "en-US";
    return serveMedia({
        mediaId: queryParams.mediaId,
        req,
        res,
        logger,
        languageCode,
        cacheControl: "private",
        accessCheck: companyOwnsMedia,
        context: {company: params.company},
    });
}

async function uploadBatch(params: any): Promise<{ids: string[]}> {
    return {ids: params.fileIds ?? []};
}

export { router };
