/**
 * Token validation API – authenticated endpoint to validate JWT and return current user info.
 *
 * Mounted under the user public routes (e.g. `/api/user/validateToken`). Requires authentication
 * (private). Read-only: validates the token and returns user id, username, company, permissions, etc.;
 * no database writes or audit logging.
 *
 * **Routes:**
 * - `GET ""` – Validate current JWT and return authenticated user information (id, username, company, permissions).
 *
 * @module f_endpoints/core/user/public/validateToken
 */

import {Router} from "express";
import {asyncHandler} from "@coreModule/utilities/middlewares/asyncHandler";
import authMW, {AuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import {
    ValidateTokenFormResponseType
} from "armonia/src/modules/core/api/user/public/validateToken/validateToken.form.response.type";

const router = Router();

/**
 * GET /api/user/validateToken
 *
 * Validates the current JWT token and returns authenticated user information.
 *
 * @route GET /api/user/validateToken
 * @access Private
 * @returns {Promise<ValidateTokenFormResponseType>} User id, username, company, email, name, surname, timezone, permissions
 *
 * @remarks
 * - Read-only; no database writes. Returns user info and company-role permissions for the current company.
 */
router.get(
    "",
    authMW("private"),
    asyncHandler(validateToken)
);
/**
 * Validates token and returns current user info and company-role permissions for the authenticated company.
 *
 * @param params - Auth context: logger, userInfo, company.
 * @returns User id, username, company, email, name, surname, timezone, maxClearance, permissions.
 */
async function validateToken(params: AuthenticatedMWType): Promise<ValidateTokenFormResponseType> {
    const {logger, userInfo, company} = params;
    try {
        logger.start("Validating token...");
        logger.finish(`Finished validating token!`);

        return {
            id: userInfo._id.toString(),
            username: userInfo.username,
            company: {_id: company._id, name: company.name},
            email: userInfo.username,
            maxClearance: 0,
            name: userInfo.name,
            surname: userInfo.surname,
            timezone: userInfo.timezone,
            photo: userInfo.photo?._id || undefined,
            cover: userInfo.cover?._id || undefined,
            permissions: await userInfo.getCompanyRolePermissions(company._id)
        };
    }
    catch (e: any) {
        logger.fail(e);
        throw(e);
    }
}

const functions = {}
module.exports = {router, functions};
