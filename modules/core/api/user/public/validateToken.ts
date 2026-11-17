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
import {isPlatformCompany} from "@coreModule/utilities/security/platformAccess";
import {
    ValidateTokenFormResponseType
} from "armonia/src/modules/core/api/user/public/validateToken/validateToken.form.response.type";
import {personErasureModules} from "@coreModule/utilities/erasure/personErasure";
import {companyService} from "@coreModule/database/schemas/company/company.service";

const router = Router();

/** Where the company is on the map (its first address with a pin), so map pickers open there instead of a fixed city. */
function companyLocation(company: {addresses?: {latitude?: number; longitude?: number}[]}): {location?: {latitude: number; longitude: number}} {
    const pinned = company.addresses?.find((address) => typeof address.latitude === "number" && typeof address.longitude === "number");
    return pinned?.latitude != null && pinned.longitude != null ? {location: {latitude: pinned.latitude, longitude: pinned.longitude}} : {};
}

/** The country of the company's first address with one, so a new address form starts in it (TD-F114). */
function companyCountry(company: {addresses?: {country?: unknown}[]}): {country?: string} {
    const country = company.addresses?.find((address) => address.country != null)?.country;
    return country != null ? {country: String(country)} : {};
}

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
 * @returns User id, username, company, email, name, surname, timezone, preferred language, maxClearance, permissions.
 */
async function validateToken(params: AuthenticatedMWType): Promise<ValidateTokenFormResponseType> {
    const {logger, userInfo, company, companyTimeZone, actionUserCtx} = params;
    try {
        logger.start("Validating token...");
        // authMW loads the company without its addresses, where its map location and country come from (TD-F114).
        const place = await companyService.findById(company._id, {}, undefined, "addresses.latitude addresses.longitude addresses.country");
        logger.finish(`Finished validating token!`);

        return {
            id: userInfo._id.toString(),
            username: userInfo.username,
            company: {_id: company._id, name: company.name, modules: actionUserCtx.modules ?? ["core"], isPlatformOwner: isPlatformCompany(company), timezone: companyTimeZone, ...companyLocation(place ?? {}), ...companyCountry(place ?? {})},
            isPlatformAdmin: isPlatformCompany(company) && actionUserCtx.isAdmin,
            canErasePeople: actionUserCtx.isAdmin === true && (await personErasureModules()).some((name) => (actionUserCtx.modules ?? []).includes(name)),
            email: userInfo.username,
            maxClearance: 0,
            name: userInfo.name,
            surname: userInfo.surname,
            timezone: userInfo.timezone,
            preferredLanguage: userInfo.preferredLanguage,
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
