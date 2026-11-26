/**
 * Company users API – private endpoints for managing users within a company context.
 *
 * Mounted under the company private routes (e.g. `/company/.../users`). All endpoints require
 * authentication and company context. Field-level access is enforced via SchemaGuard.
 *
 * **Routes:**
 * - `POST ""` – Paginated list of company users with filters (username, roles, status) and sort.
 * - `PUT ""` – Create a new user in the company (direct registration with password).
 * - `PUT "/invite"` – Invite a user by email (creates user with temp password and sends invitation).
 * - `POST "/simple"` – Lightweight paginated list (id, name, surname, fullName, photo) for simple UIs.
 * - `POST "/select"` – Paginated list as `{ value, label }[]` for dropdowns/selects.
 *
 * @module f_endpoints/core/company/private/users
 */

import {NextFunction, Request, Response, Router} from "express";
import {FilterQuery} from "mongoose";
import {ObjectId} from "mongodb";
import {asyncHandler} from "@coreModule/utilities/middlewares/asyncHandler";
import {validateFormZod} from "@coreModule/utilities/middlewares/validateFormZod";
import authMW, {AuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import User, {IUser} from "@coreModule/database/schemas/user/user";
import {
    companyUsersSimpleDataFormSchema,
} from "armonia/src/modules/core/api/company/private/users/simpleUsers.form.validator";
import {SimpleUsersFormType} from "armonia/src/modules/core/api/company/private/users/simpleUsers.form.type";
import {
    SimpleUsersFormResponseType
} from "armonia/src/modules/core/api/company/private/users/simpleUsers.form.response.type";
import type {CompanyUserType} from "armonia/src/modules/core/api/company/private/users/companyUser.dto";
import {AllUsersFormType} from "armonia/src/modules/core/api/company/private/users/allUsers.form.type";
import {getAllUsersFormSchema} from "armonia/src/modules/core/api/company/private/users/allUsers.form.validator";
import {
    createCompanyUserFormSchema
} from "armonia/src/modules/core/api/company/private/users/createUser.form.validator";
import {CreateUserFormType} from "armonia/src/modules/core/api/company/private/users/createUser.form.type";
import {
    CreateUserFormResponseType
} from "armonia/src/modules/core/api/company/private/users/createUser.form.response.type";
import {roleService} from "@coreModule/database/schemas/role/role.service";
import {userService} from "@coreModule/database/schemas/user/user.service";
import {ensureAiChannel} from "@coreModule/database/schemas/channel/channel.helper";
import {addExistingUserToCompany, buildCompanyRoleData} from "@coreModule/database/schemas/user/user.helper";
import {transactionHandler} from "@coreModule/utilities/middlewares/transactionHandler";
import {TransactionRequiredParams} from "@coreModule/utilities/middlewares/transactionUtils";
import {SendAddedToCompanyEmail, sendAccountEmailAfterCommit} from "@coreModule/utilities/database/user";
import {publishAddedToCompanyEmailEvent} from "@coreModule/kafka/kafkaProducer";
import type {AddedToCompanyEmailEvent} from "@coreModule/kafka/types";
import {receiverLanguage, roleNameIn} from "@coreModule/domain/notifications/notificationTexts";
import type {CrudOptions} from "@coreModule/database/services/baseCrudService";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {escapeRegex, generateRandomString} from "@coreModule/utilities/helpers";
import {
    inviteCompanyUserFormSchema
} from "armonia/src/modules/core/api/company/private/users/inviteUser.form.validator";
import {InviteUserFormType} from "armonia/src/modules/core/api/company/private/users/inviteUser.form.type";
import SchemaGuard from "@coreModule/database/security/schemaGuard";
import {
    companyUsersSelectFormSchema
} from "armonia/src/modules/core/api/company/private/users/getUsersSelect.form.validator";
import {GetUsersSelectFormType} from "armonia/src/modules/core/api/company/private/users/getUsersSelect.form.type";
import {rateLimiter} from "@coreModule/utilities/middlewares/rateLimiter";
import {usersToCompanyUserDTO} from "@coreModule/utilities/mappers/user/userMapper.dto";
import {schemaSanitizer, SchemaSanitizerMWType} from "@coreModule/utilities/middlewares/schemaSanitizerMW";
import {dslFilterMW, DslFilterMWType} from "@coreModule/utilities/middlewares/dslFilterMW";
import {emitNotificationEvent, NotificationEventCodes} from "@coreModule/domain/notifications/notificationEventBus";
import {mountActions, selectIdsOf} from "@coreModule/api/crudRouterFactory";
import {registerRecordResource} from "@coreModule/utilities/endpoints/recordRegistry";
import {companyStaffFilter} from "@coreModule/domain/roles/companyStaff";
import {assertAssignableRoles} from "@coreModule/domain/roles/adminRoles";
import type {IRole} from "@coreModule/database/schemas/role/role";
import {UserActions} from "@coreModule/database/schemas/user/user.actions";
import type {ActionMessage, SelectResponse, TableResponse} from "armonia/src/modules/core/types/shared.types";


/**
 * Sentinel value used in the role filter (extraData.roles) to mean "include users with no role assigned".
 * When present in the roles array, the list will include users whose company role has no roles.
 */
const NO_ROLE_FILTER_ID = "000000000000000000000000";

/** Default timezone assigned to newly created or invited users. */
const DEFAULT_NEW_USER_TIMEZONE = "Europe/Tirane";

/**
 * Ensures the user identified by email (username) can be added to the company.
 * Throws if a user with that email already belongs to the company.
 *
 * @param email - Username/email to look up.
 * @param company - Company context (must have _id).
 * @param opts - CRUD options (session, logger, languageCode).
 * @returns The existing user document if one exists but is not in this company; otherwise null.
 * @throws Api validation exception if user already has a role in the company.
 */
async function ensureUserCanBeAddedToCompany(email: string, company: { _id?: ObjectId }, opts: CrudOptions & { languageCode: string }): Promise<IUser | null> {
    const existingUser = await userService.findOne({ username: email }, opts);
    if (existingUser && company._id && (await existingUser.hasAtLeastOneRole(company._id))) {
        throw apiValidationException("user_with_same_username_already_exists_cant_create", "", null, opts.languageCode);
    }
    return existingUser ?? null;
}

/**
 * Checks that `userRole` is a role of the company that the caller may give to this person (D194: ordinary roles, or
 * General Administrator for a SysAdmin while nobody else holds it) and returns it.
 *
 * @param targetUserId - The existing account being added, or `null` for a new one.
 * @throws `one_of_the_roles_does_not_exist` or a General Administrator refusal (`assertAssignableRoles`).
 */
async function validateCompanyRole(company: AuthenticatedMWType["company"], userRole: string, actorId: string, targetUserId: ObjectId | null, opts: CrudOptions & { languageCode: string }): Promise<IRole> {
    const [role] = await assertAssignableRoles({
        roleIds: [new ObjectId(userRole)],
        company,
        actorId,
        targetUserId,
        giving: () => true,
        opts,
    });
    return role;
}

/**
 * Builds the payload object for userService.create when creating a new user in a company.
 * Used by both direct create and invite flows; only the password differs.
 *
 * @param params - email, password, name, surname, registeredFrom, companyId, companyRoleData.
 * @returns Plain object suitable for userService.create (username, password, companies, roles, etc.).
 */
function buildNewCompanyUserPayload(params: {
    email: string;
    password: string;
    name: string;
    surname: string;
    registeredFrom: ObjectId;
    companyId: ObjectId;
    companyRoleData: ReturnType<typeof buildCompanyRoleData>;
}) {
    const { email, password, name, surname, registeredFrom, companyId, companyRoleData } = params;
    return {
        username: email,
        password,
        mfaSecret: "",
        registeredFrom,
        online: false,
        name,
        surname,
        fullName: `${name} ${surname}`,
        timezone: DEFAULT_NEW_USER_TIMEZONE,
        birthday: new Date(),
        phoneNumber: "",
        companies: [companyId],
        roles: [companyRoleData],
        isEmailVerified: false
    } as any;
}

const router = Router();

/** The company user directory is other people's records. Sanitizers after this must use the others grant. */
function companyUsersListAsOthers(req: Request, _res: Response, next: NextFunction) {
    if (req.body?.actionUserCtx) {
        req.body.actionUserCtx.isSelf = false;
    }
    next();
}

/**
 * POST /api/company/users/select
 *
 * Returns active company users as options for dropdowns/selects; with `ids`, labels those users if they
 * ever belonged to the company (an inactive membership included).
 * Response: { data: Array<{ value: userId, label }>, total }.
 *
 * @route POST /api/company/users/select
 * @access Private
 * @body {GetUsersSelectFormType} - page, limit, name?, administration?
 * @returns {Promise<SelectResponse>} { data, total }
 *
 * @remarks
 * - Rate limited: 120 requests per minute
 * - No schemaSanitizer — narrow projection; not full model list read
 */
router.post(
    "/select",
    authMW("private"),
    rateLimiter({ windowMs: 60000, max: 120 }),
    validateFormZod(companyUsersSelectFormSchema),
    asyncHandler(getUsersSelect)
);
// The company's people can be shared in chat like any record, through this same select (D162).
registerRecordResource(router, {collection: "users", model: User, selectSchema: companyUsersSelectFormSchema, runSelect: getUsersSelect});
/**
 * Returns active company users as options for dropdowns/selects.
 *
 * @param params - company, page, limit, optional name, optional administration, auth context.
 * @returns { data, total } — data is array of { value, label } for use in select components.
 * @remarks No schemaSanitizer — narrow projection; not full model list read
 */
async function getUsersSelect(params: AuthenticatedMWType & GetUsersSelectFormType): Promise<SelectResponse> {
    const { logger, company, name, languageCode, actionUserCtx, page, limit, fetchAdministrationUsers } = params;
    let { administration } = params;

    if( !!fetchAdministrationUsers ) {
        administration = true;
    }

    logger.start(`Fetching company users for select...`);

    SchemaGuard.sanitizeFields(User, {name: {}, surname: {}, photo: {}}, "read", actionUserCtx, languageCode);

    const filter: FilterQuery<IUser> = {
        companies: company._id,
        "roles.company": company._id,
    }
    const opts = { logger, languageCode };
    // `ids` labels stored users (a value past page 1, a disabled select): only those, without the search or the
    // staff/customer narrowing the picker posts (TD-B225). A record keeps naming someone who has since left, so any
    // member of this company is labelled whatever their status; the search list offers active staff only (D157).
    const ids = selectIdsOf(params);
    if (ids.length > 0) {
        filter._id = { $in: ids };
    } else {
        // Active in this company: a separate `roles.active` test would also match someone active only elsewhere.
        filter.roles = { $elemMatch: { company: company._id, active: "active" } };
        if (name?.trim()) {
            const escaped = escapeRegex(name.trim());
            filter.$or = [
                { fullName: { $regex: escaped, $options: "i" } }
            ];
        }

        if (administration !== undefined) {
            const findCorrectRoles = await roleService.find(
                {
                    company: company._id,
                    isSignupDefault: !administration
                },
                opts
            );
            if (administration) {
                filter["roles.roles"] = {
                    $in: findCorrectRoles
                };
                filter.isBot = { $ne: true };
            }
            else {
                // Bots have no roles but are not customers either (same rule as the users list).
                filter.isBot = { $ne: true };
                const rolesOr = [
                    { "roles.roles": { $in: findCorrectRoles } },
                    { "roles.roles": { $size: 0 } },
                    { "roles.roles": { $exists: false } }
                ];
                if (filter.$or) {
                    filter.$and = [{ $or: filter.$or }, { $or: rolesOr }];
                    delete filter.$or;
                } else {
                    filter["$or"] = rolesOr;
                }
            }
        }
    }

    const [users, total] = await Promise.all([
        userService.find(
            filter,
            opts,
            null,
            "_id fullName photo",
            { fullName: 1 },
            limit,
            (page - 1) * limit
        ),
        userService.count(filter, opts)
    ]);

    logger.finish(`Finished fetching company users for select!`);

    return {
        data: users.map((user) => ({
            value: user._id.toString(),
            label: user.fullName,
            photo: user.photo ? String((user.photo as any)._id ?? user.photo) : undefined,
        })),
        total
    };
}

/**
 * POST /api/company/users
 *
 * Paginated list of company users with optional filters (username, roles, status) and configurable sort.
 * Excludes the current user. Administration lists include company bot users (empty roles);
 * the non-admin list excludes them. Field-level read access enforced via schemaSanitizer.
 *
 * @route POST /api/company/users
 * @access Private
 * @body {AllUsersFormType} - offset, limit, sortBy?, sortOrder?, username?, name?, status?, roles?, administration, filter?
 * @returns {Promise<TableResponse<CompanyUserType>>} total and data (CompanyUserType[])
 *
 * @remarks
 * - Rate limited: 80 requests per minute
 * - Uses schemaSanitizer + dslFilterMW when body includes filter
 * - extraData.roles may include NO_ROLE_FILTER_ID to include users with no role
 */
router.post(
    "",
    authMW("private"),
    rateLimiter({ windowMs: 60000, max: 80 }),
    validateFormZod(getAllUsersFormSchema),
    companyUsersListAsOthers,
    schemaSanitizer({ model: "users", requiredModes: ["read"] }),
    dslFilterMW({ model: "users" }),
    asyncHandler(getCompanyUsers)
);
type GetCompanyUsersType = AuthenticatedMWType & SchemaSanitizerMWType & DslFilterMWType;
/**
 * Lists company users with pagination, optional filters (username, roles, status), and configurable sort.
 *
 * @param params - Auth context, sanitizedReadFields, dslFilterQuery, extraData (username, roles, status, administration).
 * @returns Paginated list of company users with id, username, name, surname, phoneNumber, roles, status.
 * @remarks Uses params.sanitizedReadFields from schemaSanitizer; merges params.dslFilterQuery into base filter
 */
async function getCompanyUsers(params: GetCompanyUsersType & AllUsersFormType): Promise<TableResponse<CompanyUserType>> {
    const { offset, limit, sortBy, sortOrder, administration, sanitizedReadFields, dslFilterQuery, logger, userInfo, company, languageCode } = params;

    logger.start(`Trying to get company users`);

    const populate = SchemaGuard.generatePopulate(sanitizedReadFields, User.schema);
    // The mapper picks this company's membership by `roles.company`, which is not a readable field; load it
    // server-side (it is not sent back), or every row shows no roles and "inactive".
    const selectFields = populate.select?.split(" ") ?? [];
    if (selectFields.length > 0 && !selectFields.includes("roles") && !selectFields.includes("roles.company")) {
        populate.select = [...selectFields, "roles.company"].join(" ");
    }

    const filterQuery: FilterQuery<IUser> = {
        _id: { $ne: userInfo._id },
        companies: company._id,
        "roles.company": company._id,
    };

    const findCorrectRoles = await roleService.find({company: company._id, isSignupDefault: !administration}, {logger, languageCode});
    if (!!administration) {
        // Bots are created with empty roles, so they never match admin-role $in.
        // Surface them on the administration list, not the signup-user list.
        filterQuery["$or"] = [
            { "roles.roles": { $in: findCorrectRoles } },
            { isBot: true }
        ];
    }
    else {
        filterQuery["$or"] = [
            { "roles.roles": { $in: findCorrectRoles } },
            { "roles.roles": { $size: 0 } },
            { "roles.roles": { $exists: false } }
        ];
        filterQuery.isBot = { $ne: true };
    }

    if (dslFilterQuery && Object.keys(dslFilterQuery as object).length > 0) {
        filterQuery.$and = [...((filterQuery.$and as FilterQuery<IUser>[]) ?? []), dslFilterQuery];
    }

    const [data, totalCount] = await Promise.all([
        userService.find(
            filterQuery,
            {logger, languageCode},
            populate.populate,
            populate.select,
            {
                ...( (!!sortBy && !!sortOrder) ? {[sortBy]: sortOrder === "asc" ? 1 : -1} : {registerDate: -1} )
            },
            limit,
            offset
        ),
        userService.count(filterQuery, {logger, languageCode})
    ]);

    logger.finish(`Finished fetching company users`);

    return {
        total: totalCount,
        data: usersToCompanyUserDTO(data, company._id)
    }
}

/**
 * POST /api/company/users/simple
 *
 * Lightweight paginated list of active company users for simple UIs.
 * Returns only id, name, surname, fullName, photo. Optional name search.
 *
 * @route POST /api/company/users/simple
 * @access Private
 * @body {SimpleUsersFormType} - offset, limit, name?, notUser?
 * @returns {Promise<SimpleUsersFormResponseType>} total and data (SimpleUser[])
 *
 * @remarks
 * - Rate limited: 80 requests per minute
 * - No schemaSanitizer — narrow projection; not full model list read
 */
router.post(
    "/simple",
    authMW("private"),
    rateLimiter({ windowMs: 60000, max: 80 }),
    validateFormZod(companyUsersSimpleDataFormSchema),
    asyncHandler(getCompanyUsersSimple)
);

/**
 * Lightweight list of the company's staff for the chat pickers (new chat, add members): id, name, surname, photo.
 * Web users are left out: the internal chat is between staff, a web user writes through the website chat (D168).
 *
 * @param params - company, offset, limit, optional name, notUser, auth context.
 * @returns Paginated list of SimpleUser.
 * @remarks No schemaSanitizer — narrow projection; sanitize in handler
 */
async function getCompanyUsersSimple(params: AuthenticatedMWType & SimpleUsersFormType): Promise<SimpleUsersFormResponseType> {
    const { logger, company, name, languageCode, actionUserCtx, offset, limit, notUser } = params;

    logger.start(`Trying to get company users...`);
    const sanitizedFields = SchemaGuard.sanitizeFields(User, {name: {}, surname: {}, photo: {}}, "read", actionUserCtx, languageCode);
    const populate = SchemaGuard.generatePopulate(sanitizedFields, User.schema);

    const opts = { logger, languageCode };
    const filter: FilterQuery<IUser> = {
        companies: company._id,
        ...await companyStaffFilter(company._id, opts),
    };
    if( !!notUser ){
        filter["_id"] = {
            $ne: new ObjectId(notUser)
        }
    }
    if (name?.trim()) {
        const escaped = escapeRegex(name.trim());
        filter.$or = [
            { fullName: { $regex: escaped, $options: "i" } },
        ];
    }

    const [users, count] = await Promise.all([
        userService.find(
            filter,
            opts,
            populate.populate,
            (populate.select || ""),
            { fullName: 1 },
            limit,
            offset
        ),
        userService.count(filter, opts)
    ]);

    logger.finish(`Finished fetching company users!`);

    return {
        total: count,
        data: users.map((specificUserData: any) => ({
            _id: specificUserData._id.toString() ?? undefined,
            name: specificUserData?.name || undefined,
            surname: specificUserData?.surname ?? undefined,
            photo: specificUserData.photo?._id || undefined,
        }))
    };
}

/**
 * PUT /api/company/users
 *
 * Creates a new user in the company (direct registration with password).
 * If a user with the same email exists but is not in this company, adds them to the company instead.
 *
 * @route PUT /api/company/users
 * @access Private
 * @requires Transaction
 * @body {CreateUserFormType} - email, password, name, surname, userRole
 * @returns {Promise<CreateUserFormResponseType>} Success message
 *
 * @throws {apiValidationException} If user with same email already belongs to the company
 * @throws If the role is not one the caller may give (D194)
 *
 * @remarks
 * - Rate limited: 10 requests per minute
 * - Requires create permission on User model
 */
router.put(
    "",
    authMW("private"),
    rateLimiter({ windowMs: 60000, max: 10 }),
    validateFormZod(createCompanyUserFormSchema),
    transactionHandler(),
    asyncHandler(CreateNewUser)
);
type CreateNewUserType = TransactionRequiredParams & AuthenticatedMWType & SchemaSanitizerMWType;
/**
 * Creates a new user in the company (direct registration with password).
 * If a user with the same email already exists but is not in this company, they are added to the company.
 * Otherwise a new user document is created. Requires create permission on User and a role the caller may give (D194).
 *
 * @param params - email, password, name, surname, userRole, auth and transaction context.
 * @returns Success message.
 * @throws If user already in company, or role invalid, or model permission denied.
 * @remarks Uses schemaSanitizer write; builds payload from validated body + tenancy defaults
 */
async function CreateNewUser(params: CreateNewUserType & CreateUserFormType): Promise<CreateUserFormResponseType> {
    const { email, password, name, surname, userRole, logger, languageCode, userInfo, company, session, actionUserCtx } = params;
    const opts: CrudOptions & { languageCode: string } = { session, logger, languageCode };

    logger.start(`Trying to register new user...`);
    SchemaGuard.checkModelPermission(User, "create", actionUserCtx);

    const existingUser = await ensureUserCanBeAddedToCompany(email, company, opts);
    const roleDoc = await validateCompanyRole(company, userRole, actionUserCtx.userId, existingUser?._id ?? null, opts);
    const companyRoleData = buildCompanyRoleData(userRole, company._id);

    let newUser: IUser;
    if (existingUser) {
        newUser = existingUser;
        await addExistingUserToCompany(existingUser, company._id, companyRoleData, opts);
    }
    else {
        newUser = await userService.create(
            {
                ...buildNewCompanyUserPayload({
                    email,
                    password,
                    name,
                    surname,
                    registeredFrom: userInfo._id,
                    companyId: company._id,
                    companyRoleData
                }),
                "requests.activation": {
                    date: Date.now()
                }
            },
            { ...opts, auditUserId: actionUserCtx.userId }
        );
        await newUser.sendActivationEmail(email, languageCode, session, logger);

        // Give the newly created company user their single AI-assistant channel.
        // (The existingUser branch handles this inside addExistingUserToCompany.)
        await ensureAiChannel({
            userId: newUser._id,
            companyId: company._id,
            session: session ?? null,
            logger,
            languageCode,
            auditUserId: actionUserCtx.userId,
        });
    }

    const assignerNameCreated = `${userInfo.name || ""} ${userInfo.surname || ""}`.trim() || userInfo.username;
    emitNotificationEvent(NotificationEventCodes.ROLE_ASSIGNED, {
        receiverIds: [newUser._id.toString()],
        payload: {
            companyId: company._id.toString(),
            roleName: roleDoc.name,
            roleSlugs: roleDoc.slug,
            roleId: userRole,
            assignerId: actionUserCtx.userId,
            assignerUsername: assignerNameCreated,
            languageCode
        },
        session
    });

    logger.finish(`Successfully register new user with username / id: [${email} / ${newUser._id}]!`);
    return {
        message: "User created successfully!",
        _id: newUser._id.toString(),
        name: newUser.name,
        surname: newUser.surname,
    };
}

/**
 * PUT /api/company/users/invite
 *
 * Invites a user to the company by email. Creates user with temporary password if new, or adds company to existing user.
 * Sends invitation email when creating a new user (optional welcome message).
 *
 * @route PUT /api/company/users/invite
 * @access Private
 * @requires Transaction
 * @body {InviteUserFormType} - email, name, surname, userRole, welcomeMessage?
 * @returns {Promise<ActionMessage>} Success message
 *
 * @throws {apiValidationException} If user with same email already belongs to the company
 * @throws If the role is not one the caller may give (D194)
 *
 * @remarks
 * - Rate limited: 10 requests per minute
 * - Requires create permission on User model
 * - New users receive an invitation email; existing users are added to the company and told by email (D187)
 */
router.put(
    "/invite",
    authMW("private"),
    rateLimiter({ windowMs: 60000, max: 10 }),
    validateFormZod(inviteCompanyUserFormSchema),
    transactionHandler(),
    asyncHandler(inviteUser)
);
type InviteUserType = TransactionRequiredParams & AuthenticatedMWType & SchemaSanitizerMWType;
/**
 * Invites a user to the company by email. Creates a user with a temporary password if they do not exist,
 * or adds the company to an existing user. Either way an email goes out after commit, with the optional welcome message:
 * the invitation to a new user, the added-to-company notice to an existing one (D187).
 * Requires create permission on User and a role the caller may give (D194).
 *
 * @param params - email, name, surname, userRole, welcomeMessage, auth and transaction context.
 * @returns Success message.
 * @throws If user already in company, or role invalid, or model permission denied.
 * @remarks Uses schemaSanitizer write; builds payload from validated body + tenancy defaults
 */
async function inviteUser(params: InviteUserType & InviteUserFormType): Promise<ActionMessage> {
    const { email, name, surname, userRole, welcomeMessage, logger, languageCode, userInfo, company, session, actionUserCtx } = params;
    const opts: CrudOptions & { languageCode: string } = { session, logger, languageCode, auditUserId: actionUserCtx.userId };

    logger.start(`Trying to invite user [${email}]...`);
    SchemaGuard.checkModelPermission(User, "create", actionUserCtx);

    const existingUser = await ensureUserCanBeAddedToCompany(email, company, opts);
    const invitedRoleDoc = await validateCompanyRole(company, userRole, actionUserCtx.userId, existingUser?._id ?? null, opts);
    const companyRoleData = buildCompanyRoleData(userRole, company._id);

    const inviterName = `${userInfo.name || ""} ${userInfo.surname || ""}`.trim() || userInfo.username;

    if (existingUser) {
        await addExistingUserToCompany(existingUser, company._id, companyRoleData, opts);
        emitNotificationEvent(NotificationEventCodes.ROLE_ASSIGNED, {
            receiverIds: [existingUser._id.toString()],
            payload: {
                companyId: company._id.toString(),
                roleName: invitedRoleDoc.name,
                roleSlugs: invitedRoleDoc.slug,
                roleId: userRole,
                assignerId: actionUserCtx.userId,
                assignerUsername: inviterName,
                languageCode
            },
            session
        });
        // An account needs no acceptance: the email only tells them, in their language, where they now work (D187).
        const recipientLanguage = receiverLanguage(existingUser);
        const fullName = [existingUser.name, existingUser.surname].filter(Boolean).join(" ") || existingUser.username;
        const roleName = roleNameIn(invitedRoleDoc, recipientLanguage);
        const addedEmail: AddedToCompanyEmailEvent = {
            eventType: "added_to_company_email",
            email: existingUser.username,
            userId: existingUser._id.toString(),
            fullName,
            welcomeMessage: welcomeMessage || "",
            inviterName,
            companyName: company.name,
            roleName,
            languageCode: recipientLanguage,
            timestamp: Date.now(),
            companyId: company._id.toString(),
        };
        await sendAccountEmailAfterCommit(session, logger, "added to company", () => publishAddedToCompanyEmailEvent(addedEmail), () => SendAddedToCompanyEmail(addedEmail));
    }
    else {
        const newUser = await userService.create(
            {
                ...buildNewCompanyUserPayload({
                    email,
                    password: generateRandomString(64),
                    name,
                    surname,
                    registeredFrom: userInfo._id,
                    companyId: company._id,
                    companyRoleData: {
                        ...companyRoleData,
                        active: "invited"
                    }
                }),
                "requests.invitation": {
                    invitedBy: userInfo._id,
                    invitedAt: Date.now(),
                    company: company._id,
                    welcomeMessage: welcomeMessage || "",
                }
            },
            opts
        );
        await newUser.sendInvitationEmail(
            welcomeMessage || "",
            company.name,
            inviterName,
            languageCode,
            company._id,
            session,
            logger
        );
        emitNotificationEvent(NotificationEventCodes.INVITATION_RECEIVED, {
            receiverIds: [newUser._id.toString()],
            payload: {
                companyId: company._id.toString(),
                companyName: company.name,
                inviterId: userInfo._id.toString(),
                inviterName,
                languageCode
            },
            session
        });
    }

    logger.finish(`Successfully invited user [${email}]!`);
    return { message: "User invitation sent successfully!" };
}

// The account-request transitions as staff actions (D65): POST /<method> with the target `_id` in the body.
mountActions(router, UserActions, User);

export { router };