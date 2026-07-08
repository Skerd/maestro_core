import {Request, Response, Router} from 'express';
import {asyncHandler} from '@coreModule/utilities/middlewares/asyncHandler';
import {getLogger} from '@coreModule/loggers/serverLog';
import {serveMedia} from "@coreModule/utilities/media/serveMedia";
import authMW from "@coreModule/utilities/middlewares/authMW";
import {rateLimiter} from "@coreModule/utilities/middlewares/rateLimiter";
import {mediaUploadMW} from "@coreModule/utilities/middlewares/mediaUploadMW";

const router = Router();

/**
 * @route   GET /api/auxiliary/public/media/:mediaId
 * @desc    Securely serve media file by ID
 * @access  Public (but validates file exists in database)
 */
router.get(
    "/:mediaId",
    asyncHandler(serveMediaFile)
);

router.post(
    "/upload-batch",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 30}),
    mediaUploadMW({fieldName: "files", maxFiles: 50, maxFileSize: 100 * 1024 * 1024}),
    asyncHandler(uploadBatch),
);

async function serveMediaFile(params: any, queryParams: any, req: Request, res: Response) {
    const logger = getLogger("serve_media_file");
    const languageCode = req.header("language") || "en-US";
    return serveMedia({mediaId: queryParams.mediaId, req, res, logger, languageCode});
}

async function uploadBatch(params: any): Promise<{ids: string[]}> {
    return {ids: params.fileIds ?? []};
}

export { router };
