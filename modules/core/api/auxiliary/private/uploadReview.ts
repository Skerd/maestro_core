/**
 * The platform's upload review (D177): the lists and decisions (`UploadReviewActions`, POST `/list`, `/approve`,
 * `/remove`). The reviewed file itself is a media route (GET `/api/auxiliary/media/review/:mediaId`), where the media
 * cookie reaches. Platform company only, with the permission `reviewUploads` of the platform-only upload review model
 * (`UploadRefusal`), which the panel's access map lists.
 *
 * @module api/auxiliary/private/uploadReview
 */

import {Router} from "express";
import UploadRefusal from "@coreModule/database/schemas/uploadRefusal/uploadRefusal";
import {mountActions} from "@coreModule/api/crudRouterFactory";
import {UploadReviewActions} from "@coreModule/database/schemas/media/uploadReview.actions";

const router = Router();

mountActions(router, UploadReviewActions, UploadRefusal);

export {router};
