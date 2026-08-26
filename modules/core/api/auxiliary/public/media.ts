import {Request, Response, Router} from "express";
import {asyncHandler} from "@coreModule/utilities/middlewares/asyncHandler";
import authMW, {NotAuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import {rateLimiter} from "@coreModule/utilities/middlewares/rateLimiter";
import {getLogger} from "@coreModule/loggers/serverLog";
import {serveMedia} from "@coreModule/utilities/media/serveMedia";
import {resolveCompanyByOrigin} from "@coreModule/utilities/marketing/resolveCompanyByOrigin";

const router = Router();

router.get(
    "/:mediaId",
    authMW("public"),
    rateLimiter({windowMs: 60000, max: 120}),
    asyncHandler(servePublicMediaFile),
);

async function servePublicMediaFile(
    params: NotAuthenticatedMWType,
    queryParams: {mediaId: string},
    req: Request,
    res: Response,
) {
    const logger = getLogger("serve_public_media_file");
    const {languageCode, origin} = params;
    const company = await resolveCompanyByOrigin(origin, languageCode);

    return serveMedia({
        mediaId: queryParams.mediaId,
        req,
        res,
        logger,
        languageCode,
        cacheControl: "public",
        deniedAsNotFound: true,
        accessCheck: async (_id, media) => {
            const mediaCompany = String((media.company as {_id?: unknown})?._id ?? media.company ?? "");
            return media.isPublic === true && mediaCompany === String(company._id);
        },
    });
}

export { router };
export const basePath = "/api/auxiliary/public/media";
