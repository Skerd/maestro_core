/**
 * User account status API – private endpoints for managing account active state in a company context.
 *
 * Mounted under the user private routes (e.g. `/api/user/status`). All endpoints require
 * authentication and company context. Field-level access is enforced via SchemaGuard.
 * Status changes are audited to track who activated/deactivated accounts.
 *
 * **Routes:**
 * - `GET ""` – Check if the user account is active for the current company.
 * - `DELETE ""` – Self-deactivate account for the current company (requires password verification).
 * - `PUT ""` – Update user account status (activate/deactivate); admin-only, cannot update own status.
 *
 * @module f_endpoints/core/user/private/status
 */

import {Router} from "express";
import {asyncHandler} from "@coreModule/utilities/middlewares/asyncHandler";
import authMW, {AuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import {transactionHandler} from "@coreModule/utilities/middlewares/transactionHandler";
import {TransactionRequiredParams} from "@coreModule/utilities/middlewares/transactionUtils";
import {DisableAccountFormType} from "armonia/src/modules/core/api/user/private/status/disableAccount.form.type";
import {
    UpdateAccountStatusFormType
} from "armonia/src/modules/core/api/user/private/status/updateAccountStatus.form.type";
import {
    DisableAccountFormResponseType
} from "armonia/src/modules/core/api/user/private/status/disableAccount.form.response.type";
import {disableAccountFormSchema} from "armonia/src/modules/core/api/user/private/status/disableAccount.form.validator";
import {
    UpdateAccountStatusFormResponseType
} from "armonia/src/modules/core/api/user/private/status/updateAccountStatus.form.response.type";
import {
    updateAccountStatusFormSchema
} from "armonia/src/modules/core/api/user/private/status/updateAccountStatus.form.validator";
import {
    UserStatusFormResponseType
} from "armonia/src/modules/core/api/user/private/status/userStatus.form.response.type";
import {userService} from "@coreModule/database/schemas/user/user.service";
import SchemaGuard from "@coreModule/database/security/schemaGuard";
import User from "@coreModule/database/schemas/user/user";
import {ObjectId} from "mongodb";
import {rateLimiter} from "@coreModule/utilities/middlewares/rateLimiter";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {validateFormZod} from "@coreModule/utilities/middlewares/validateFormZod";
import {emitNotificationEvent, NotificationEventCodes} from "@coreModule/domain/notifications/notificationEventBus";

const router = Router();

/**
 * GET /api/user/status
 *
 * Checks if the user account is active for the current company.
 *
 * @route GET /api/user/status
 * @access Private
 * @returns {Promise<UserStatusFormResponseType>} Account active status
 *
 * @remarks
 * - Rate limited: 260 requests per minute
 * - Returns active status from the user's embedded CompanyRole for the current company
 * - Respects read permissions for roles.active field
 * - Returns false if no role found for the company
 */
router.get(
    "",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 60}),
    asyncHandler(userStatus)
);
/**
 * Checks if user account is active for the current company.
 * Respects SchemaGuard for roles.active read access.
 *
 * @param params - Auth context, company, logger, userInfo, actionUserCtx, languageCode.
 * @returns Account active status { active: boolean } from the user's CompanyRole for the current company.
 */
async function userStatus(params: AuthenticatedMWType): Promise<UserStatusFormResponseType> {
    const { logger, userInfo, company, actionUserCtx, languageCode} = params;
    
    logger.start("Serving account status...");
    const sanitizeFields = SchemaGuard.sanitizeFields(User, {roles: {keys: {active: {}}}}, "read", actionUserCtx, languageCode);
    const populate = SchemaGuard.generatePopulate(sanitizeFields, User.schema);

    const user = await userService.findOne(
        {
            _id: userInfo._id,
            "roles.company": company._id
        },
        {logger, languageCode},
        populate.populate,
        (populate.select || "") + " roles.company"
    );

    logger.finish("Finished serving account status!");
    const activeVal = user?.roles?.find(role => role.company.toString() === company._id.toString())?.active;
    return {
        active: activeVal === "active",
    };
}

/**
 * DELETE /api/user/status
 *
 * Self-deactivates the user's account for the current company. Requires password verification.
 *
 * @route DELETE /api/user/status
 * @access Private
 * @requires Transaction
 * @requires Permission: not_others_action (user can only deactivate their own account)
 * @body {DisableAccountFormType} - Password for verification
 * @returns {Promise<DisableAccountFormResponseType>} Success message
 *
 * @throws {apiValidationException} If password verification fails
 *
 * @remarks
 * - Rate limited: 10 requests per minute
 * - Requires write permission for roles.active field
 * - Verifies password before deactivating account
 * - Resets unsuccessful login attempts before deactivation
 * - Changes are audited with actor information
 * - User can only deactivate their own account (enforced by validatePermissions)
 */
router.delete(
    "",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 10}),
    validateFormZod(disableAccountFormSchema),
    transactionHandler(),
    asyncHandler(disableSelfUserAccount)
);
/**
 * Self-deactivates user account for the current company after password verification.
 * Resets unsuccessful logins and audits the change.
 *
 * @param params - Transaction, form (password), auth context, company, session, actionUserCtx.
 * @returns Success message confirming deactivation.
 */
async function disableSelfUserAccount(params: TransactionRequiredParams & DisableAccountFormType & AuthenticatedMWType): Promise<DisableAccountFormResponseType> {
    const { password, languageCode, logger, userInfo, session, company, actionUserCtx, parentBypass} = params;

    logger.start(`Deactivating account...`);

    if( !!parentBypass ){
        throw apiValidationException("user_permissions_not_sufficient", null, null, languageCode);
    }

    SchemaGuard.sanitizeFields(User, {roles: {keys: {active: {}}}}, "write", actionUserCtx, languageCode);

    // Verify password before deactivating
    await userInfo.checkPassword(company._id, password, languageCode);

    // Set auditUserId before calling methods that save
    userInfo.$locals = userInfo.$locals || {};
    userInfo.$locals.auditUserId = new ObjectId(actionUserCtx.userId);

    // Reset unsuccessful login attempts
    await userInfo.resetUnsuccessfulLogins(company._id);

    await userInfo.changeAccountStatus(company._id, false, session);

    emitNotificationEvent(NotificationEventCodes.ACCOUNT_SELF_DEACTIVATED, {
        receiverIds: [userInfo._id.toString()],
        payload: {
            companyId: company._id.toString(),
            languageCode
        },
        session
    });

    logger.finish(`Successfully deactivated account!`);

    return {
        message: "Your account has been deactivated successfully. Account active status: Deactivated"
    };
}


/**
 * PUT /api/user/status
 *
 * Updates the user account status (activate/deactivate) for the current company.
 * Admin-only operation – users cannot update their own status via this endpoint.
 *
 * @route PUT /api/user/status
 * @access Private
 * @requires Transaction
 * @requires Permission: not_self_action (admin cannot update their own status via this endpoint)
 * @body {UpdateAccountStatusFormType} - New status (true = active, false = inactive)
 * @returns {Promise<UpdateAccountStatusFormResponseType>} Success message with new status
 *
 * @remarks
 * - Rate limited: 10 requests per minute
 * - Admin endpoint for activating/deactivating user accounts
 * - Requires write permission for roles.active field (checked by SchemaGuard)
 * - Users cannot update their own status (enforced by validatePermissions)
 * - Changes are audited with actor information
 * - Updates the embedded CompanyRole.active field for the specified company
 */
router.put(
    "",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 10}),
    validateFormZod(updateAccountStatusFormSchema),
    transactionHandler(),
    asyncHandler(updateUserAccountStatus)
);
/**
 * Updates user account status (activate/deactivate) for the current company.
 * Admin-only; requires write permission for roles.active. Changes are audited.
 *
 * @param params - Transaction, form (status), auth context, company, session, actionUserCtx.
 * @returns Success message with new status (message, status).
 */
async function updateUserAccountStatus(params: TransactionRequiredParams & UpdateAccountStatusFormType & AuthenticatedMWType): Promise<UpdateAccountStatusFormResponseType> {
    const { status, logger, userInfo, session, languageCode, company, actionUserCtx, actionUserInfo, parentBypass } = params;

    logger.start(`Trying to update account status...`);

    if( !parentBypass ){
        throw apiValidationException("user_permissions_not_sufficient", null, null, languageCode);
    }
    
    // Verify write permission for roles.active field
    SchemaGuard.sanitizeFields(User, {roles: {keys: {active: {}}}}, "write", actionUserCtx, languageCode);

    // Set auditUserId before calling method that saves
    userInfo.$locals = userInfo.$locals || {};
    userInfo.$locals.auditUserId = new ObjectId(actionUserCtx.userId);

    await userInfo.changeAccountStatus(company._id, status, session);

    const actorUsername =
        `${actionUserInfo.name || ""} ${actionUserInfo.surname || ""}`.trim() || actionUserInfo.username;
    emitNotificationEvent(NotificationEventCodes.ACCOUNT_STATUS_CHANGED_BY_ADMIN, {
        receiverIds: [userInfo._id.toString()],
        payload: {
            companyId: company._id.toString(),
            activated: status,
            actorId: actionUserCtx.userId,
            actorUsername,
            languageCode
        },
        session
    });

    logger.finish(`Finished updating account status!`);

    return {
        message: `User account status updated successfully. New user account status: ${status ? "Activated" : "Deactivated"}`,
        status: status
    };
}


export { router };
