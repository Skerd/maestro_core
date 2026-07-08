/**
 * User permissions API – private endpoints for role selection, updating user roles, and checking resource access.
 *
 * Mounted under the user private routes (e.g. `/user/.../permissions`). All endpoints require authentication.
 * Role and access checks use SchemaGuard.
 *
 * **Routes:**
 * - `POST "/accessible/roles/select"` – Paginated company roles for dropdowns (value/label), filterable by name and administration.
 * - `PUT "/roles"` – Update the current user's company roles (requires parentBypass; runs in a transaction).
 * - `POST "/access"` – Check read/write/create/delete access for a resource and optional field lists.
 * - `POST "/access/all"` – Check create/delete/restore access for all registered Mongoose models.
 *
 * @module f_endpoints/core/user/private/permissions
 */
import {Router} from "express";
import mongoose, {FilterQuery, ModelPermissionAction} from "mongoose";
import {ObjectId} from "mongodb";
import {asyncHandler} from "@coreModule/utilities/middlewares/asyncHandler";
import {transactionHandler} from "@coreModule/utilities/middlewares/transactionHandler";
import {TransactionRequiredParams} from "@coreModule/utilities/middlewares/transactionUtils";
import authMW, {AuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {ChangeUserRolesFormType} from "armonia/src/modules/core/api/user/private/permissions/changeUserRoles.form.type";
import {
    ChangeUserRolesFormResponseType
} from "armonia/src/modules/core/api/user/private/permissions/changeUserRoles.form.response.type";
import {roleService} from "@coreModule/database/schemas/role/role.service";
import {userService} from "@coreModule/database/schemas/user/user.service";
import {emitNotificationEvent, NotificationEventCodes} from "@coreModule/domain/notifications/notificationEventBus";
import Role, {IRole} from "@coreModule/database/schemas/role/role";
import SchemaGuard from "@coreModule/database/security/schemaGuard";
import {AccessibleRolesFormType} from "armonia/src/modules/core/api/user/private/permissions/accessibleRoles.form.type";
import {
    AccessibleRolesFormResponseType
} from "armonia/src/modules/core/api/user/private/permissions/accessibleRoles.form.response.type";
import {
    accessibleRolesFormSchema
} from "armonia/src/modules/core/api/user/private/permissions/accessibleRoles.form.validator";
import {validateFormZod} from "@coreModule/utilities/middlewares/validateFormZod";
import {rateLimiter} from "@coreModule/utilities/middlewares/rateLimiter";
import {AccessFormType} from "armonia/src/modules/core/api/user/private/permissions/access.form.type";
import {AccessFormResponseType} from "armonia/src/modules/core/api/user/private/permissions/access.form.response.type";
import {AccessAllFormType} from "armonia/src/modules/core/api/user/private/permissions/accessAll.form.type";
import {
    AccessAllFormResponseType
} from "armonia/src/modules/core/api/user/private/permissions/accessAll.form.response.type";
import {accessAllFormSchema} from "armonia/src/modules/core/api/user/private/permissions/accessAll.form.validator";
import User, {IEmbeddedCompanyRole} from "@coreModule/database/schemas/user/user";
import {accessFormSchema} from "armonia/src/modules/core/api/user/private/permissions/access.form.validator";
import {
    changeUserRolesFormSchema
} from "armonia/src/modules/core/api/user/private/permissions/changeUserRoles.form.validator";
import {COLLECTED_DATA, getModelCollectedData} from "@coreModule/database/collections";
import {filterTableConfigBySanitizedFields} from "@coreModule/database/filter/schemaToTableConfig";
import {SanitizedFields} from "armonia/src/modules/core/types";
import {escapeRegex} from "@coreModule/utilities/helpers";

/**
 * Derives the Mongoose model name (PascalCase singular) from a resourceId (camelCase plural).
 *
 * @param resourceId - Resource identifier in camelCase plural (e.g. "companyUsers").
 * @returns Model name in PascalCase singular (e.g. "CompanyUser").
 */
function resourceIdToModelName(resourceId: string): string {
    const parts = resourceId.split(/(?=[A-Z])/).map((s) => s.toLowerCase());
    if (parts.length === 0) return "";
    const last = parts[parts.length - 1];
    const singular =
        last.endsWith("ies") && last.length > 3
            ? last.slice(0, -3) + "y"
            : last.endsWith("es") && !last.endsWith("ies") && last.length >= 3
                ? (() => {
                      const withoutS = last.slice(0, -1);
                      const withoutEs = last.slice(0, -2);
                      // e.g. addresses→address, boxes→box: stem ends in s/x/z/ch/sh → remove "es"
                      if (/[sxz]$|ch$|sh$/.test(withoutEs)) return withoutEs;
                      // e.g. roles→role: removing only "s" yields word ending in "e"
                      if (withoutS.endsWith("e")) return withoutS;
                      return withoutEs;
                  })()
                : last.endsWith("s") && !last.endsWith("ss") && last.length >= 2
                    ? last.slice(0, -1)
                    : last;
    parts[parts.length - 1] = singular;
    return parts.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
}

const router = Router();

/**
 * POST /api/user/permissions/accessible/roles/select
 *
 * Returns company roles as options for dropdowns/selects (value: role id, label: role name).
 * Only non-admin roles; optional name search and administration filter.
 *
 * @route POST /api/user/permissions/accessible/roles/select
 * @access Private
 * @body {AccessibleRolesFormType} - page, limit, name?, administration?
 * @returns {Promise<AccessibleRolesFormResponseType>} data (value/label[]), total
 *
 * @remarks
 * - Rate limited: 120 requests per minute
 */
router.post(
    "/accessible/roles/select",
    authMW("private"),
    rateLimiter({ windowMs: 60000, max: 120 }),
    validateFormZod(accessibleRolesFormSchema),
    asyncHandler(GetAccessibleRoles)
);

/**
 * Fetches accessible company roles for select components. Paginated; filterable by name and administration.
 * Only non-admin roles are returned.
 *
 * @param params - Auth context, company, page, limit, optional name and administration.
 * @returns Paginated list of { value: role id, label: role name } and total count.
 */
async function GetAccessibleRoles(params: AuthenticatedMWType & AccessibleRolesFormType): Promise<AccessibleRolesFormResponseType> {
    const { logger, company, actionUserCtx, languageCode, name, page, limit, administration } = params;

    logger.start(`Fetching accessible roles for select...`);

    const sanitizeFields = SchemaGuard.sanitizeFields(Role, {name: {}}, "read", actionUserCtx, languageCode);
    const populate = SchemaGuard.generatePopulate(sanitizeFields, Role.schema);

    const filter: FilterQuery<IRole> = {
        company: company._id,
        isAdmin: false,
    };

    if (name?.trim()) {
        const escaped = escapeRegex(name.trim());
        filter.name = { $regex: escaped, $options: "i" };
    }

    if (administration !== undefined) {
        filter["isSignupDefault"] = !administration;
    }

    const opts = { logger, languageCode };

    const [roles, total] = await Promise.all([
        roleService.find(
            filter,
            opts,
            populate.populate,
            populate.select || "",
            { name: 1 },
            limit,
            (page - 1) * limit
        ),
        roleService.count(filter, opts)
    ]);

    logger.finish(`Finished fetching accessible roles for select!`);

    return {
        data: (roles ?? []).map((role) => ({
            value: role._id.toString(),
            label: role.name
        })),
        total
    };
}

/**
 * PUT /api/user/permissions/roles
 *
 * Updates the current user's roles for the current company. Replaces the company role entry with the given role IDs.
 * Requires parentBypass (e.g. admin). Returns the updated roles with permissions.
 *
 * @route PUT /api/user/permissions/roles
 * @access Private
 * @requires Transaction
 * @body {ChangeUserRolesFormType} - roles (string[])
 * @returns {Promise<ChangeUserRolesFormResponseType[]>} Updated roles with clearanceLevel, name, _id, permissions
 *
 * @throws {apiValidationException} If parentBypass missing, or a role does not exist, or company role not found
 *
 * @remarks
 * - Rate limited: 20 requests per minute
 */
router.put(
    '/roles',
    authMW("private"),
    rateLimiter({ windowMs: 60000, max: 20 }),
    validateFormZod(changeUserRolesFormSchema),
    transactionHandler(),
    asyncHandler(UpdateUserRoles)
);

/**
 * Updates the current user's company roles with the given role IDs. Creates or updates the embedded company role.
 * Requires parentBypass. Runs within a transaction.
 *
 * @param params - roles, auth context, company, session, parentBypass, actionUserCtx.
 * @returns Updated roles with clearanceLevel, name, _id, permissions.
 * @throws {apiValidationException} If parentBypass missing, a role does not exist, or company role not found.
 */
async function UpdateUserRoles(params: TransactionRequiredParams & ChangeUserRolesFormType & AuthenticatedMWType): Promise<ChangeUserRolesFormResponseType[]> {
    const { roles, logger, userInfo, company, languageCode, session, parentBypass, actionUserCtx, actionUserInfo } = params;
    const opts = { session, logger, languageCode };

    logger.start(`Updating user roles...`);

    if (!parentBypass) {
        throw apiValidationException("user_permissions_not_sufficient", null, null, languageCode);
    }

    SchemaGuard.sanitizeFields(User, {roles: {keys: {roles: {}}}}, "write", actionUserCtx, languageCode);

    const newRolesObjectIds = roles.map((role) => new ObjectId(role));
    const filter: FilterQuery<IRole> = {
        _id: { $in: newRolesObjectIds },
        company: company._id,
        isAdmin: false
    };

    const foundRoles = await roleService.find(filter, opts);

    if( foundRoles.length !== roles.length ){
        throw apiValidationException("one_of_the_roles_does_not_exist", null, null, languageCode);
    }

    const user = await userService.findByIdOrThrow(userInfo._id, opts);

    const companyRoleIndex = user.roles.findIndex((role: IEmbeddedCompanyRole) => role.company._id.equals(company._id));

    let fetchThese: ObjectId[] = [];
    if (companyRoleIndex === -1) {
        const newCompanyRole = {
            active: "active",
            unsuccessfulLogins: 0,
            lockedOutUntil: null,
            lastLogin: null,
            rolesCount: newRolesObjectIds.length,
            roles: newRolesObjectIds,
            company: company._id
        };

        await userService.updateById(
            userInfo._id,
            { $push: { roles: newCompanyRole } },
            { ...opts, auditUserId: actionUserCtx.userId }
        );
        fetchThese = newRolesObjectIds;
    }
    else {
        let foundRole = userInfo.roles.find((role) => role.company.equals(company._id));
        if( !!foundRole ){
            let alreadyPresentRoles = foundRole.roles.filter((role) => foundRoles.find((userRole) => userRole._id.equals(role)));
            let notPresentRoles = foundRoles.filter((role) => !foundRole.roles.find((userRole) => userRole.equals(role._id)));
            let finalRoles = foundRole.roles.filter((role) => !alreadyPresentRoles.find((userRole) => userRole._id.equals(role)));
            finalRoles = [...finalRoles, ...notPresentRoles];

            const uniqueRolesMap = new Map<string, any>();
            for (const role of finalRoles) {
                uniqueRolesMap.set(role._id.toString(), role);
            }
            finalRoles = Array.from(uniqueRolesMap.values());
            foundRole.roles = finalRoles;
            foundRole.rolesCount = finalRoles.length;
            userInfo.$locals = userInfo.$locals || {};
            userInfo.$locals.auditUserId = new ObjectId(actionUserCtx.userId);
            await userInfo.save({session});
            fetchThese = finalRoles.map((role) => role._id);
        }
        else{
            throw apiValidationException("companyRole_not_found", null, null, languageCode);
        }
    }

    logger.finish(`Finished updating user roles!`);

    const updatedUserRoles = await roleService.find(
        { _id: { $in: fetchThese }, company: company._id },
        opts
    );

    const allUserRoles: ChangeUserRolesFormResponseType[] = [];
    for (const role of updatedUserRoles) {
        allUserRoles.push({
            clearanceLevel: 0,
            name: role.name,
            _id: role._id.toString(),
            permissions: await role.getPermissions()
        });
    }

    const roleNames = updatedUserRoles.map((r) => r.name).join(", ");
    const assignerUsername = `${actionUserInfo.name || ""} ${actionUserInfo.surname || ""}`.trim() || actionUserInfo.username;
    emitNotificationEvent(
        NotificationEventCodes.ROLE_ASSIGNED, 
        {
            receiverIds: [userInfo._id.toString()],
            payload: {
                companyId: company._id.toString(),
                roleName: roleNames,
                roleId: updatedUserRoles[0]?._id.toString(),
                assignerId: actionUserCtx.userId,
                assignerUsername,
                languageCode
            },
            session
        }
    );

    return allUserRoles;
}

/**
 * POST /api/user/permissions/access
 *
 * Checks whether the current user can read/write/create/delete a resource. Optionally checks specific read/write fields.
 * resourceId is camelCase plural (e.g. companyUsers); converted to model name for SchemaGuard.
 *
 * @route POST /api/user/permissions/access
 * @access Private
 * @body {AccessFormType} - resourceId, isForOthers, readFields?, writeFields?
 * @returns {Promise<AccessFormResponseType>} read, write, create, delete (false or allowed fields)
 *
 * @remarks
 * - Rate limited: 300 requests per minute
 * - If resourceId does not map to a registered model, returns { read, write, create, delete: false } (no access).
 * - Permission errors set the corresponding flag to false and are logged at debug
 */
router.post(
    "/access",
    authMW("private"),
    rateLimiter({ windowMs: 60000, max: 300 }),
    validateFormZod(accessFormSchema),
    asyncHandler(AccessResource)
);

/**
 * Checks read/write/create/delete access for a resource. Optionally validates specific readFields/writeFields.
 * resourceId must be a valid camelCase plural that maps to a registered Mongoose model.
 *
 * @param params - resourceId, isForOthers, readFields, writeFields, auth context, languageCode, logger.
 * @returns Object with read, write, create, delete (each false or the allowed fields). Returns all false if resourceId has no registered model.
 */
async function AccessResource(
    params: AuthenticatedMWType & AccessFormType
): Promise<AccessFormResponseType> {
    const { languageCode, logger, actionUserCtx, resourceId, readFields, writeFields, isForOthers } = params;

    actionUserCtx.isSelf = !isForOthers;

    logger.start(`Ready to check if user can access resource [${resourceId}]...`);

    const defaultNoAccess: AccessFormResponseType = {
        read: false,
        write: false,
        create: false,
        delete: false,
        restore: false,
        tableConfiguration: false
    };

    const modelName = resourceIdToModelName(resourceId);
    if (!mongoose.modelNames().includes(modelName)) {
        logger.finish(`Resource [${resourceId}] not found; returning no access.`);
        return defaultNoAccess;
    }
    const requestedResource = mongoose.model(modelName);

    const {readFields: collectedReadFields, writeFields: collectedWriteFields, tableConfiguration} = getModelCollectedData(resourceId);

    let returnThis: AccessFormResponseType = defaultNoAccess;

    if (readFields || collectedWriteFields) {
        try {
            // collectedReadFields takes precedence over readFields
            const sanitizeFields = SchemaGuard.sanitizeFields(requestedResource, collectedReadFields ?? readFields, "read", actionUserCtx, languageCode);
            returnThis.read = Object.keys(sanitizeFields).length > 0 ? sanitizeFields : false;
        } catch (e) {
            logger.debug?.(e);
        }
    }
    if (writeFields || collectedWriteFields) {
        try {
            // collectedWriteFields takes precedence over writeFields
            const sanitizeFields = SchemaGuard.sanitizeFields(requestedResource, collectedWriteFields ?? writeFields, "write", actionUserCtx, languageCode);
            returnThis.write = Object.keys(sanitizeFields).length > 0 ? sanitizeFields : false;
        } catch (e) {
            logger.debug?.(e);
        }
    }
    if (tableConfiguration){
        returnThis.tableConfiguration = filterTableConfigBySanitizedFields(tableConfiguration, returnThis.read);
    }
    for( let action of ["create", "delete", "restore"] as ModelPermissionAction[] ){
        try {
            SchemaGuard.checkModelPermission(requestedResource, action, actionUserCtx);
            returnThis[action] = true;
        }catch (e){
            logger.debug?.(e);
        }
    }

    logger.finish(`Finished checking if user can access resource!`);
    return returnThis;
}

/**
 * POST /api/user/permissions/access/all
 *
 * Checks create/delete/restore access for all registered Mongoose models. Returns an object keyed by model name.
 * read/write are always false (field-level checks require resource-specific readFields/writeFields).
 *
 * @route POST /api/user/permissions/access/all
 * @access Private
 * @body {AccessAllFormType} - isForOthers? (default false)
 * @returns {Promise<AccessAllFormResponseType>} { [modelName]: AccessFormResponseType }
 *
 * @remarks
 * - Rate limited: 60 requests per minute (bulk operation)
 * - Useful for building permission-aware UIs that need to show/hide actions per model
 */
router.post(
    "/access/all",
    authMW("private"),
    rateLimiter({ windowMs: 60000, max: 60 }),
    validateFormZod(accessAllFormSchema),
    asyncHandler(AccessAllResources)
);


/**
 * Checks create/delete/restore access for all registered Mongoose models.
 * read/write remain false (field-level checks require model-specific readFields/writeFields via POST /access).
 *
 * @param params - isForOthers, auth context, languageCode, logger.
 * @returns Object keyed by model name, each value an AccessFormResponseType.
 */
async function AccessAllResources(params: AuthenticatedMWType & AccessAllFormType): Promise<AccessAllFormResponseType> {
    const { languageCode, logger, actionUserCtx } = params;

    logger.start(`Checking access for all registered models...`);

    const defaultNoAccess: AccessFormResponseType = {
        read: false,
        write: false,
        create: false,
        delete: false,
        restore: false,
        tableConfiguration: false
    };

    const result: AccessAllFormResponseType = {};
    const modelNames = mongoose.modelNames();

    // return result;
    const generateAccess = (model: any, target: "self" | "others", readFields: SanitizedFields, writeFields: SanitizedFields): AccessFormResponseType => {

        let returnThis: AccessFormResponseType = { ...defaultNoAccess };
        actionUserCtx.isSelf = target === "self";

        try{
            returnThis.read = SchemaGuard.sanitizeFields(model, readFields, "read", actionUserCtx, languageCode);
        }catch (e){
            logger.debug?.(e);
        }

        try{
            returnThis.write = SchemaGuard.sanitizeFields(model, writeFields, "write", actionUserCtx, languageCode);
        }catch (e){
            logger.debug?.(e);
        }

        try {
            SchemaGuard.checkModelPermission(model, "create", actionUserCtx);
            returnThis.create = true;
        } catch (e) {
            logger.debug?.(e);
        }
        try {
            SchemaGuard.checkModelPermission(model, "delete", actionUserCtx);
            returnThis.delete = true;
        } catch (e) {
            logger.debug?.(e);
        }
        try {
            SchemaGuard.checkModelPermission(model, "restore", actionUserCtx);
            returnThis.restore = true;
        } catch (e) {
            logger.debug?.(e);
        }

        return returnThis;
    }

    for( let collectedData of Object.values(COLLECTED_DATA) ) {

        const model =  collectedData.model;
        const modelName = collectedData.model.collection.name;
        const modelOptions = (model.schema as any).options;
        if( modelOptions.accessMode === "loose"){
            result[modelName] = {
                self: generateAccess(model, "self", collectedData.readFields, collectedData.writeFields),
                others: undefined
            }
        }
        else{
            result[modelName] = {
                self: generateAccess(model, "self", collectedData.readFields, collectedData.writeFields),
                others: generateAccess(model, "others", collectedData.readFields, collectedData.writeFields)
            }
        }
    }

    logger.finish(`Finished checking access for ${modelNames.length} models!`);
    return result;
}

/** Express router for user permissions endpoints. Mount under the user private path. */
export { router };
