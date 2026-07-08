/**
 * User login API – private endpoints for authentication and session management.
 *
 * Mounted under the user private routes (e.g. `/user/login/...`). All endpoints require
 * authentication. Token generation does not modify user data, so no audit logging is required.
 *
 * **Routes:**
 * - `POST "/differentCompany"` – Re-authenticate for a different company and receive new JWT tokens.
 *
 * @module f_endpoints/core/user/private/login
 */

import {Router} from "express";
import {ObjectId} from "mongodb";
import {asyncHandler} from "@coreModule/utilities/middlewares/asyncHandler";
import authMW, {AuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import {
    ReloginDifferentCompanyFormType
} from "armonia/src/modules/core/api/user/private/login/reloginDifferentCompany.form.type";
import {
    reloginDifferentCompanyFormSchema
} from "armonia/src/modules/core/api/user/private/login/reloginDifferentCompany.form.validator";
import {companyService} from "@coreModule/database/schemas/company/company.service";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {
    ReloginDifferentCompanyFormResponseType
} from "armonia/src/modules/core/api/user/private/login/reloginDifferentCompany.form.response.type";
import {rateLimiter} from "@coreModule/utilities/middlewares/rateLimiter";
import {validateFormZod} from "@coreModule/utilities/middlewares/validateFormZod";

const router = Router();


/**
 * POST /api/user/login/differentCompany
 *
 * Re-authenticates the user for a different company, generating new JWT tokens.
 * Allows users to switch between companies they have access to without full re-login.
 *
 * @route POST /api/user/login/differentCompany
 * @access Private
 * @body {ReLoginDifferentCompanyFormType} - companyId (target company to switch to)
 * @returns {Promise<ReloginDifferentCompanyFormResponseType>} token and refreshToken
 *
 * @throws {apiValidationException} If company not found
 * @throws {apiValidationException} If user does not have at least one role in the company
 * @throws {apiValidationException} If company is inactive and user is not admin
 *
 * @remarks
 * - Rate limited: 60 requests per minute
 * - User must have at least one role in the target company
 * - Non-admin users cannot switch to inactive companies; admins can
 * - Uses existing session ID; no database writes, so no audit logging
 */
router.post(
    "/differentCompany",
    authMW("private"),
    rateLimiter({ windowMs: 60000, max: 60 }),
    validateFormZod(reloginDifferentCompanyFormSchema),
    asyncHandler(ReLoginDifferentCompany)
);
/**
 * Re-authenticates the user for a different company and generates new JWT and refresh tokens.
 *
 * @param params - Auth context and form (companyId).
 * @returns token and refreshToken for the target company.
 */
async function ReLoginDifferentCompany(
    params: ReloginDifferentCompanyFormType & AuthenticatedMWType
): Promise<ReloginDifferentCompanyFormResponseType> {
    const { logger, userInfo, companyId, languageCode, requestSource, deviceId, userAgent, requestIp } = params;

    logger.start(`Trying to re-authenticate...`);

    const company = await companyService.findByIdOrThrow(
        new ObjectId(companyId),
        { logger, languageCode }
    );

    const hasRole = await userInfo.hasAtLeastOneRole(company._id);
    if (!hasRole) {
        throw apiValidationException("user_must_have_at_least_one_role", null, null, languageCode);
    }
    if( !(await userInfo.isAdmin(company._id)) ){
        if( !company.isActive ){
            throw apiValidationException("company_inactive", null, null, languageCode);
        }
    }

    const {session: userSessionRow} = await userInfo.createOrUpdateSession(
        company._id,
        deviceId ?? "",
        userAgent ?? "",
        requestIp ?? "",
        null as any,
        languageCode
    );

    const { token, refreshToken } = await userInfo.generateJWTToken(
        company._id,
        requestSource,
        userSessionRow._id.toString(),
        languageCode
    );

    logger.finish(`Successfully re-authenticated!`);

    return {
        token,
        refreshToken
    };
}

export { router };
