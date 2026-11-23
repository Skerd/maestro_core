import {Router} from "express";
import {ObjectId} from "mongodb";
import authMW, {type NotAuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import {asyncHandler} from "@coreModule/utilities/middlewares/asyncHandler";
import {rateLimiter} from "@coreModule/utilities/middlewares/rateLimiter";
import {validateFormZod} from "@coreModule/utilities/middlewares/validateFormZod";
import {transactionHandler} from "@coreModule/utilities/middlewares/transactionHandler";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {
    portalSavedSearchStopFormSchema,
    type PortalSavedSearchStopFormType,
} from "armonia/src/modules/core/api/portal/private/saved/portalSaved.form.validator";
import type {PortalSavedSearchStopResponse} from "armonia/src/modules/core/api/portal/private/saved/portalSaved.dto";
import {portalSavedSearchService} from "@coreModule/database/schemas/portalSavedSearch/portalSavedSearch.service";
import {validateRecordAccessToken, type RecordAccessTokenPayload} from "@coreModule/utilities/security/recordAccessToken";
import {SAVED_SEARCH_STOP_PURPOSE} from "@coreModule/utilities/cronJobs/savedSearchAlertsJob";
import type {ClientSession} from "mongoose";

/**
 * The stop link of a saved-search alert (D178, P23.7), followed from a mailbox without signing in: its token names the
 * one saved search whose alerts it turns off, and can do nothing else (a typed record-access token, never a session).
 * - POST /stop — turn the search's alerts off; answers with its words
 */
export const basePath = "/api/portal/savedSearchAlerts";
export const router = Router();

router.post(
    "/stop",
    authMW("public"),
    rateLimiter({windowMs: 60000, max: 20}),
    validateFormZod(portalSavedSearchStopFormSchema),
    transactionHandler(),
    asyncHandler(async (params: NotAuthenticatedMWType & PortalSavedSearchStopFormType & {session: ClientSession}): Promise<PortalSavedSearchStopResponse> => {
        const {token, logger, languageCode, session} = params;
        let claims: RecordAccessTokenPayload;
        try {
            claims = validateRecordAccessToken(token, SAVED_SEARCH_STOP_PURPOSE, languageCode);
        } catch {
            // Not `token_verification_failed`: the browser reads that as an expired session and signs a visitor out.
            throw apiValidationException("not_found", "token", null, languageCode);
        }
        const {companyId, recordId} = claims;
        const search = await portalSavedSearchService.findOne(
            {_id: new ObjectId(recordId), company: new ObjectId(companyId), deletedAt: null},
            {logger, languageCode, session, withDeleted: false},
        );
        if (!search) throw apiValidationException("not_found", "", null, languageCode);
        if (search.alerts) {
            search.set({alerts: false});
            await search.save({session});
        }
        return {data: {label: search.label}};
    }),
);
