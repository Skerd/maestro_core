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

import {Router} from "express";
import {FilterQuery} from "mongoose";
import {Decimal128, ObjectId} from "mongodb";
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
import {AllUsersFormResponseType} from "armonia/src/modules/core/api/company/private/users/allUsers.form.response.type";
import {AllUsersFormType} from "armonia/src/modules/core/api/company/private/users/allUsers.form.type";
import {getAllUsersFormSchema} from "armonia/src/modules/core/api/company/private/users/allUsers.form.validator";
import {
    createCompanyUserFormSchema
} from "armonia/src/modules/core/api/company/private/users/createUser.form.validator";
import {CreateUserFormType} from "armonia/src/modules/core/api/company/private/users/createUser.form.type";
import {
    CreateUserFormResponseType
} from "armonia/src/modules/core/api/company/private/users/createUser.form.response.type";
import {currencyService} from "@coreModule/database/schemas/currency/currency.service";
import {financeService} from "@coreModule/database/schemas/finance/finance.service";
import {roleService} from "@coreModule/database/schemas/role/role.service";
import {userService} from "@coreModule/database/schemas/user/user.service";
import {ensureAiChannel} from "@coreModule/database/schemas/channel/aiChannel.helper";
import {transactionHandler} from "@coreModule/utilities/middlewares/transactionHandler";
import {TransactionRequired, TransactionRequiredParams} from "@coreModule/utilities/middlewares/transactionUtils";
import type {CrudOptions} from "@coreModule/database/services/baseCrudService";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {FinanceCurrencies} from "@coreModule/database/schemas/finance/finance";
import {escapeRegex, generateRandomString} from "@coreModule/utilities/helpers";
import {
    inviteCompanyUserFormSchema
} from "armonia/src/modules/core/api/company/private/users/inviteUser.form.validator";
import {
    InviteUserFormResponseType
} from "armonia/src/modules/core/api/company/private/users/inviteUser.form.response.type";
import {InviteUserFormType} from "armonia/src/modules/core/api/company/private/users/inviteUser.form.type";
import SchemaGuard from "@coreModule/database/security/schemaGuard";
import {
    companyUsersSelectFormSchema
} from "armonia/src/modules/core/api/company/private/users/getUsersSelect.form.validator";
import {GetUsersSelectFormType} from "armonia/src/modules/core/api/company/private/users/getUsersSelect.form.type";
import {rateLimiter} from "@coreModule/utilities/middlewares/rateLimiter";
import {
    GetUsersSelectFormResponseType
} from "armonia/src/modules/core/api/company/private/users/getUsersSelect.form.response.type";
import {usersToCompanyUserDTO} from "@coreModule/utilities/mappers/user/userMapper.dto";
import {schemaSanitizer, SchemaSanitizerMWType} from "@coreModule/utilities/middlewares/schemaSanitizerMW";
import {dslFilterMW, DslFilterMWType} from "@coreModule/utilities/middlewares/dslFilterMW";
import {
    unlockActivationFormSchema
} from "armonia/src/modules/core/api/company/private/users/unlockActivation.form.validator";
import {
    UnlockActivationFormResponseType
} from "armonia/src/modules/core/api/company/private/users/unlockActivation.form.response.type";
import {
    unlockPasswordResetFormSchema
} from "armonia/src/modules/core/api/company/private/users/unlockPasswordReset.form.validator";
import {
    UnlockPasswordResetFormResponseType
} from "armonia/src/modules/core/api/company/private/users/unlockPasswordReset.form.response.type";
import {
    unlockMfaDeactivationFormSchema
} from "armonia/src/modules/core/api/company/private/users/unlockMfaDeactivation.form.validator";
import {
    UnlockMfaDeactivationFormResponseType
} from "armonia/src/modules/core/api/company/private/users/unlockMfaDeactivation.form.response.type";
import {
    resendInvitationEmailFormSchema
} from "armonia/src/modules/core/api/company/private/users/resendInvitationEmail.form.validator";
import {
    ResendInvitationEmailFormResponseType
} from "armonia/src/modules/core/api/company/private/users/resendInvitationEmail.form.response.type";
import {
    resendActivationEmailFormSchema
} from "armonia/src/modules/core/api/company/private/users/resendActivationEmail.form.validator";
import {
    ResendActivationEmailFormResponseType
} from "armonia/src/modules/core/api/company/private/users/resendActivationEmail.form.response.type";
import {
    unlockInvitationFormSchema
} from "armonia/src/modules/core/api/company/private/users/unlockInvitation.form.validator";
import {
    UnlockInvitationFormResponseType
} from "armonia/src/modules/core/api/company/private/users/unlockInvitation.form.response.type";
import {UnlockInvitationFormType} from "armonia/src/modules/core/api/company/private/users/unlockInvitation.form.type";
import {emitNotificationEvent, NotificationEventCodes} from "@coreModule/domain/notifications/notificationEventBus";


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
async function ensureUserCanBeAddedToCompany(email: string, company: { _id?: ObjectId }, opts: CrudOptions): Promise<IUser | null> {
    const existingUser = await userService.findOne({ username: email }, opts);
    if (existingUser && company._id && (await existingUser.hasAtLeastOneRole(company._id))) {
        throw apiValidationException("user_with_same_username_already_exists_cant_create", null, null, opts.languageCode);
    }
    return existingUser ?? null;
}

/**
 * Validates that the given role ID is a valid, non-admin company role for the company.
 *
 * @param company - Company with getAllRoles() (and _id for the query).
 * @param userRole - Role ID (string) to validate.
 * @param opts - CRUD options for roleService.findOneOrThrow.
 * @throws If the role is not found or is not a non-admin company role.
 */
async function validateCompanyRole(company: { _id?: ObjectId; getAllRoles(): Promise<Array<{ _id?: ObjectId }>> }, userRole: string, opts: CrudOptions): Promise<void> {
    const allRoles = await company.getAllRoles();
    const companyRoleIds = allRoles.map((r) => r._id).filter((id): id is ObjectId => id != null);
    await roleService.findOneOrThrow(
        {
            $and: [
                { _id: new ObjectId(userRole) },
                { _id: { $in: companyRoleIds } },
                { isAdmin: false }
            ],
            company: company._id
        },
        opts
    );
}

/**
 * Creates a new finance document for a company user with zero balance for all system currencies.
 *
 * @param companyId - Company the finance record belongs to.
 * @param opts - CRUD options (session, logger, languageCode, optional auditUserId).
 * @returns The created finance document (with _id).
 */
async function createFinanceForNewCompanyUser(companyId: ObjectId, opts: CrudOptions) {
    const currencies = await currencyService.find({}, opts);
    const financeCurrencies: FinanceCurrencies[] = currencies.map((currency) => ({
        currency: currency._id,
        amount: Decimal128.fromString("0.0")
    }));
    return financeService.create(
        {
            currencies: financeCurrencies,
            transactions: [],
            company: companyId
        } as any,
        opts
    );
}

/**
 * Builds the embedded company-role subdocument added to a user when they join a company.
 *
 * @param userRole - Role ID (string) to assign.
 * @param companyId - Company ID for the role.
 * @returns Plain object suitable for `roles` array (active, unsuccessfulLogins, roles, company, etc.).
 */
function buildCompanyRoleData(userRole: string, companyId: ObjectId) {
    return {
        active: "active",
        unsuccessfulLogins: 0,
        lockedOutUntil: null,
        lastLogin: null,
        rolesCount: 1,
        roles: [new ObjectId(userRole)],
        company: companyId
    };
}

/**
 * Adds an existing user to the company by appending the company, finance ID, and role to their document.
 *
 * @param existingUser - User document to update.
 * @param companyId - Company to add.
 * @param newFinance - Newly created finance document (must have _id).
 * @param companyRoleData - Role data from buildCompanyRoleData.
 * @param opts - CRUD options for the update.
 * @throws If the finance document has no _id.
 */
async function addExistingUserToCompany(existingUser: IUser, companyId: ObjectId, newFinance: { _id?: ObjectId }, companyRoleData: ReturnType<typeof buildCompanyRoleData>, opts: CrudOptions): Promise<void> {
    await userService.updateByIdOrThrow(
        existingUser._id,
        {
            $addToSet: {
                companies: companyId,
                finance: newFinance._id
            },
            $push: { roles: companyRoleData }
        },
        opts
    );

    // Ensure this user has their single AI-assistant channel with the company bot.
    await ensureAiChannel({
        userId: existingUser._id,
        companyId,
        session: opts.session ?? null,
        logger: opts.logger,
        languageCode: opts.languageCode,
        auditUserId: opts.auditUserId,
    });
}

/**
 * Builds the payload object for userService.create when creating a new user in a company.
 * Used by both direct create and invite flows; only the password differs.
 *
 * @param params - email, password, name, surname, registeredFrom, companyId, financeId, companyRoleData.
 * @returns Plain object suitable for userService.create (username, password, companies, roles, etc.).
 */
function buildNewCompanyUserPayload(params: {
    email: string;
    password: string;
    name: string;
    surname: string;
    registeredFrom: ObjectId;
    companyId: ObjectId;
    financeId: ObjectId;
    companyRoleData: ReturnType<typeof buildCompanyRoleData>;
}) {
    const { email, password, name, surname, registeredFrom, companyId, financeId, companyRoleData } = params;
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
        finance: [financeId],
        roles: [companyRoleData],
        isEmailVerified: false
    } as any;
}

const router = Router();

/**
 * POST /api/company/users/select
 *
 * Returns active company users as options for dropdowns/selects.
 * Response: { data: Array<{ value: userId, label }>, total }.
 *
 * @route POST /api/company/users/select
 * @access Private
 * @body {GetUsersSelectFormType} - page, limit, name?, administration?
 * @returns {Promise<GetUsersSelectFormResponseType>} { data, total }
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
/**
 * Returns active company users as options for dropdowns/selects.
 *
 * @param params - company, page, limit, optional name, optional administration, auth context.
 * @returns { data, total } — data is array of { value, label } for use in select components.
 * @remarks No schemaSanitizer — narrow projection; not full model list read
 */
async function getUsersSelect(params: AuthenticatedMWType & GetUsersSelectFormType): Promise<GetUsersSelectFormResponseType> {
    const { logger, company, name, languageCode, actionUserCtx, page, limit, fetchAdministrationUsers } = params;
    let { administration } = params;

    if( !!fetchAdministrationUsers ) {
        administration = true;
    }

    logger.start(`Fetching company users for select...`);

    SchemaGuard.sanitizeFields(User, {name: {}, surname: {}}, "read", actionUserCtx, languageCode);

    const filter: FilterQuery<IUser> = {
        companies: company._id,
        "roles.company": company._id,
        "roles.active": "active"
    }
    if (name?.trim()) {
        const escaped = escapeRegex(name.trim());
        filter.$or = [
            { fullName: { $regex: escaped, $options: "i" } }
        ];
    }

    const opts = { logger, languageCode };
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
        }
        else {
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

    const [users, total] = await Promise.all([
        userService.find(
            filter,
            opts,
            null,
            "_id fullName",
            { fullName: 1 },
            limit,
            (page - 1) * limit
        ),
        userService.count(filter, opts)
    ]);

    logger.finish(`Finished fetching company users for select!`);

    return {
        data: users.map((user) => ({value: user._id.toString(), label: user.fullName})),
        total
    };
}

/**
 * POST /api/company/users
 *
 * Paginated list of company users with optional filters (username, roles, status) and configurable sort.
 * Excludes the current user. Field-level read access enforced via schemaSanitizer.
 *
 * @route POST /api/company/users
 * @access Private
 * @body {AllUsersFormType} - offset, limit, sortBy?, sortOrder?, username?, name?, status?, roles?, administration, filter?
 * @returns {Promise<AllUsersFormResponseType>} total and data (CompanyUserType[])
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
async function getCompanyUsers(params: GetCompanyUsersType & AllUsersFormType): Promise<AllUsersFormResponseType> {
    const { offset, limit, sortBy, sortOrder, administration, sanitizedReadFields, dslFilterQuery, logger, userInfo, company, languageCode, actionUserCtx } = params;

    logger.start(`Trying to get company users`);
    actionUserCtx.isSelf = false;

    const populate = SchemaGuard.generatePopulate(sanitizedReadFields, User.schema);

    const filterQuery: FilterQuery<IUser> = {
        _id: { $ne: userInfo._id },
        companies: company._id,
        "roles.company": company._id,
    };

    const findCorrectRoles = await roleService.find({company: company._id, isSignupDefault: !administration}, {logger, languageCode});
    if (!!administration) {
        filterQuery["roles.roles"] = { $in: findCorrectRoles };
    }
    else {
        filterQuery["$or"] = [
            { "roles.roles": { $in: findCorrectRoles } },
            { "roles.roles": { $size: 0 } },
            { "roles.roles": { $exists: false } }
        ];
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
        data: usersToCompanyUserDTO(data)
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
 * @returns {Promise<SimpleUsersFormResponseType>} total and data (SimpleUserType[])
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
 * Lightweight list of active company users for simple UIs: id, name, surname, fullName, photo.
 *
 * @param params - company, offset, limit, optional name, notUser, auth context.
 * @returns Paginated list of SimpleUserType.
 * @remarks No schemaSanitizer — narrow projection; sanitize in handler
 */
async function getCompanyUsersSimple(params: AuthenticatedMWType & SimpleUsersFormType): Promise<SimpleUsersFormResponseType> {
    const { logger, company, name, languageCode, actionUserCtx, offset, limit, notUser } = params;

    logger.start(`Trying to get company users...`);
    const sanitizedFields = SchemaGuard.sanitizeFields(User, {name: {}, surname: {}, photo: {}}, "read", actionUserCtx, languageCode);
    const populate = SchemaGuard.generatePopulate(sanitizedFields, User.schema);

    const filter: FilterQuery<IUser> = {
        companies: company._id,
        "roles.company": company._id,
        "roles.active": "active"
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

    const opts = { logger, languageCode };

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
 * @throws If role is invalid or not a non-admin company role
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
 * Otherwise a new user document is created. Requires create permission on User and a valid non-admin company role.
 *
 * @param params - email, password, name, surname, userRole, auth and transaction context.
 * @returns Success message.
 * @throws If user already in company, or role invalid, or model permission denied.
 * @remarks Uses schemaSanitizer write; builds payload from validated body + tenancy defaults
 */
async function CreateNewUser(params: CreateNewUserType & CreateUserFormType): Promise<CreateUserFormResponseType> {
    const { email, password, name, surname, userRole, logger, languageCode, userInfo, company, session, actionUserCtx } = params;
    const opts: CrudOptions = { session, logger, languageCode };

    logger.start(`Trying to register new user...`);
    SchemaGuard.checkModelPermission(User, "create", actionUserCtx);

    const existingUser = await ensureUserCanBeAddedToCompany(email, company, opts);
    await validateCompanyRole(company, userRole, opts);
    const newFinance = await createFinanceForNewCompanyUser(company._id, opts);
    const companyRoleData = buildCompanyRoleData(userRole, company._id);

    let newUser: IUser;
    if (existingUser) {
        newUser = existingUser;
        await addExistingUserToCompany(existingUser, company._id, newFinance, companyRoleData, opts);
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
                    financeId: newFinance._id,
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

    const roleDoc = await roleService.findOneOrThrow(
        {
            _id: new ObjectId(userRole),
            company: company._id,
            isAdmin: false
        },
        { ...opts, auditUserId: actionUserCtx.userId }
    );
    const assignerNameCreated = `${userInfo.name || ""} ${userInfo.surname || ""}`.trim() || userInfo.username;
    emitNotificationEvent(NotificationEventCodes.ROLE_ASSIGNED, {
        receiverIds: [newUser._id.toString()],
        payload: {
            companyId: company._id.toString(),
            roleName: roleDoc.name,
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
 * @returns {Promise<InviteUserFormResponseType>} Success message
 *
 * @throws {apiValidationException} If user with same email already belongs to the company
 * @throws If role is invalid or not a non-admin company role
 *
 * @remarks
 * - Rate limited: 10 requests per minute
 * - Requires create permission on User model
 * - New users receive an invitation email; existing users are only added to the company
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
 * or adds the company to an existing user. Sends an invitation email (when creating new user) with optional welcome message.
 * Requires create permission on User and a valid non-admin company role.
 *
 * @param params - email, name, surname, userRole, welcomeMessage, auth and transaction context.
 * @returns Success message.
 * @throws If user already in company, or role invalid, or model permission denied.
 * @remarks Uses schemaSanitizer write; builds payload from validated body + tenancy defaults
 */
async function inviteUser(params: InviteUserType & InviteUserFormType): Promise<InviteUserFormResponseType> {
    const { email, name, surname, userRole, welcomeMessage, logger, languageCode, userInfo, company, session, actionUserCtx } = params;
    const opts: CrudOptions = { session, logger, languageCode, auditUserId: actionUserCtx.userId };

    logger.start(`Trying to invite user [${email}]...`);
    SchemaGuard.checkModelPermission(User, "create", actionUserCtx);

    const existingUser = await ensureUserCanBeAddedToCompany(email, company, opts);
    await validateCompanyRole(company, userRole, opts);
    const newFinance = await createFinanceForNewCompanyUser(company._id, opts);
    const companyRoleData = buildCompanyRoleData(userRole, company._id);

    const inviterName = `${userInfo.name || ""} ${userInfo.surname || ""}`.trim() || userInfo.username;

    if (existingUser) {
        await addExistingUserToCompany(existingUser, company._id, newFinance, companyRoleData, opts);
        const invitedRoleDoc = await roleService.findOneOrThrow(
            {
                _id: new ObjectId(userRole),
                company: company._id,
                isAdmin: false
            },
            opts
        );
        emitNotificationEvent(NotificationEventCodes.ROLE_ASSIGNED, {
            receiverIds: [existingUser._id.toString()],
            payload: {
                companyId: company._id.toString(),
                roleName: invitedRoleDoc.name,
                roleId: userRole,
                assignerId: actionUserCtx.userId,
                assignerUsername: inviterName,
                languageCode
            },
            session
        });
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
                    financeId: newFinance._id,
                    companyRoleData: {
                        ...companyRoleData,
                        active: "invited"
                    }
                }),
                "requests.invitation": {
                    invitedBy: userInfo._id,
                    invitedAt: Date.now(),
                    company: company._id
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

/**
 * PATCH /api/company/users/unlock-activation
 *
 * Clears the activation lockedUntil for a company user (admin unlock).
 * Requires specificUser header with target user id.
 *
 * @route PATCH /api/company/users/unlock-activation
 * @access Private
 * @requires Transaction
 * @requires specificUser header (target user id)
 * @requires Write permission for requests.activation.lockedUntil
 */
router.patch(
    "/unlockActivation",
    authMW("private"),
    rateLimiter({ windowMs: 60000, max: 30 }),
    validateFormZod(unlockActivationFormSchema),
    transactionHandler(),
    asyncHandler(unlockActivation)
);
/**
 * Unlocks activation lock for a company user.
 */
async function unlockActivation(body: any): Promise<UnlockActivationFormResponseType> {
    const { userInfo, logger, languageCode, actionUserCtx, session, parentBypass, resendEmail } = body;

    if (!parentBypass) {
        throw apiValidationException("user_permissions_not_sufficient", null, null, languageCode);
    }

    logger.start(`Unlocking activation for user ${userInfo._id}`);

    const sanitizedFields = SchemaGuard.sanitizeFields(User, { requests: { keys: { activation: { keys: { lockedUntil: {}, date: {} } } } } }, "write", actionUserCtx, languageCode);
    await userService.updateByIdOrThrow(
        userInfo._id,
        {
            $unset: {
              "requests.activation.lockedUntil": "",
              "requests.activation.attempts": "",
            }
        },
        { session, logger, languageCode, auditUserId: actionUserCtx.userId }
    );

    if (resendEmail && sanitizedFields?.requests?.keys?.activation?.keys?.date) {
        const targetUser = await userService.findOneOrThrow(
            { _id: userInfo._id },
            { session, logger, languageCode }
        );
        targetUser.$locals = targetUser.$locals || {};
        targetUser.$locals.auditUserId = actionUserCtx.userId;
        await targetUser.sendActivationEmail(targetUser.username, languageCode, session, logger);
        logger.info(`Activation email resent to user ${userInfo._id}`);
    }

    logger.finish(`Activation unlocked for user ${userInfo._id}`);
    return { message: "Activation lock cleared successfully" };
}

/**
 * PATCH /api/company/users/:userId/unlock-password-reset
 *
 * Clears the password reset lockedUntil for a company user (admin unlock).
 * Requires specificUser header with target user id.
 *
 * @route PATCH /api/company/users/unlock-password-reset
 * @access Private
 * @requires Transaction
 * @requires specificUser header (target user id)
 * @requires Write permission for requests.passwordReset.lockedUntil
 */
router.patch(
    "/unlockPasswordReset",
    authMW("private"),
    rateLimiter({ windowMs: 60000, max: 30 }),
    validateFormZod(unlockPasswordResetFormSchema),
    transactionHandler(),
    asyncHandler(unlockPasswordReset)
);

/**
 * Unlocks password reset lock for a company user.
 */
async function unlockPasswordReset(body: any): Promise<UnlockPasswordResetFormResponseType> {
    const { userInfo, logger, languageCode, actionUserCtx, session, parentBypass, resendEmail } = body;

    if (!parentBypass) {
        throw apiValidationException("user_permissions_not_sufficient", null, null, languageCode);
    }

    logger.start(`Unlocking password reset for user ${userInfo._id}`);

    SchemaGuard.sanitizeFields(User, { requests: { keys: { passwordReset: { keys: { lockedUntil: {} } } } } }, "write", actionUserCtx, languageCode);

    await userService.updateByIdOrThrow(
        userInfo._id,
        {
            $unset: {
                "requests.passwordReset": ""
            }
        },
        { session, logger, languageCode, auditUserId: actionUserCtx.userId }
    );

    if (resendEmail) {
        const targetUser = await userService.findOneOrThrow(
            { _id: userInfo._id },
            { session, logger, languageCode }
        );
        targetUser.$locals = targetUser.$locals || {};
        targetUser.$locals.auditUserId = actionUserCtx.userId;
        await targetUser.sendForgotPasswordEmail(languageCode, session, logger);
        logger.info(`Password reset email resent to user ${userInfo._id}`);
    }

    logger.finish(`Password reset unlocked for user ${userInfo._id}`);
    return { message: "Password reset lock cleared successfully" };
}

/**
 * PATCH /api/company/users/unlock-mfa-deactivation
 *
 * Clears the MFA deactivation lockedUntil for a company user (admin unlock).
 * Requires specificUser header with target user id.
 *
 * @route PATCH /api/company/users/unlock-mfa-deactivation
 * @access Private
 * @requires Transaction
 * @requires specificUser header (target user id)
 * @requires Write permission for requests.mfaDeactivation.lockedUntil
 */
router.patch(
    "/unlockMfaDeactivation",
    authMW("private"),
    rateLimiter({ windowMs: 60000, max: 30 }),
    validateFormZod(unlockMfaDeactivationFormSchema),
    transactionHandler(),
    asyncHandler(unlockMfaDeactivation)
);
/**
 * Unlocks MFA deactivation lock for a company user.
 */
async function unlockMfaDeactivation(body: any): Promise<UnlockMfaDeactivationFormResponseType> {
    const { userInfo, logger, languageCode, actionUserCtx, session, parentBypass, resendEmail } = body;

    if (!parentBypass) {
        throw apiValidationException("user_permissions_not_sufficient", null, null, languageCode);
    }

    logger.start(`Unlocking MFA deactivation for user ${userInfo._id}`);

    SchemaGuard.sanitizeFields(User, { requests: { keys: { mfaDeactivation: { keys: { lockedUntil: {} } } } } }, "write", actionUserCtx, languageCode);

    await userService.updateByIdOrThrow(
        userInfo._id,
        {
            $unset: {
                "requests.mfaDeactivation": ""
            }
        },
        { session, logger, languageCode, auditUserId: actionUserCtx.userId }
    );

    if (resendEmail) {
        const targetUser = await userService.findOneOrThrow(
            { _id: userInfo._id },
            { session, logger, languageCode }
        );
        targetUser.$locals = targetUser.$locals || {};
        targetUser.$locals.auditUserId = actionUserCtx.userId;
        await targetUser.sendDisableMfaEmail(languageCode, session, logger);
        logger.info(`MFA deactivation email resent to user ${userInfo._id}`);
    }

    logger.finish(`MFA deactivation unlocked for user ${userInfo._id}`);
    return { message: "MFA deactivation lock cleared successfully" };
}

/**
 * PATCH /api/company/users/unlockInvitation
 *
 * Clears the invitation lockedUntil and attempts for a company user (admin unlock).
 * Requires specificUser header with target user id.
 *
 * @route PATCH /api/company/users/unlockInvitation
 * @access Private
 * @requires Transaction
 * @requires specificUser header (target user id)
 * @requires Write permission for requests.invitation.lockedUntil
 */
router.patch(
    "/unlockInvitation",
    authMW("private"),
    rateLimiter({ windowMs: 60000, max: 30 }),
    validateFormZod(unlockInvitationFormSchema),
    transactionHandler(),
    asyncHandler(unlockInvitation)
);

async function unlockInvitation(body: AuthenticatedMWType & TransactionRequired & UnlockInvitationFormType): Promise<UnlockInvitationFormResponseType> {
    const { userInfo, logger, languageCode, actionUserCtx, session, parentBypass, resendEmail, company} = body;

    if (!parentBypass) {
        throw apiValidationException("user_permissions_not_sufficient", null, null, languageCode);
    }

    if ( !(company._id.equals(userInfo.requests?.invitation?.company)) ){
        throw apiValidationException("cannot_unlock_invitation", null, null, languageCode);
    }
    if (!userInfo.requests?.invitation) {
        throw apiValidationException("invitation_not_found", null, null, languageCode);
    }
    if (userInfo.requests.invitation.accepted === true) {
        throw apiValidationException("invitation_already_accepted", null, null, languageCode);
    }

    logger.start(`Unlocking invitation for user ${userInfo._id}`);

    SchemaGuard.sanitizeFields(User, { requests: { keys: { invitation: { keys: { lockedUntil: {} } } } } }, "write", actionUserCtx, languageCode);

    await userService.updateByIdOrThrow(
        userInfo._id,
        {
            $unset: {
                "requests.invitation.lockedUntil": "",
                "requests.invitation.attempts": "",
            }
        },
        { session, logger, languageCode, auditUserId: actionUserCtx.userId }
    );

    if (resendEmail) {
        const receiverUser = await userService.findOneOrThrow(
            { _id: userInfo._id },
            { session, logger, languageCode }
        );
        const welcomeMessage = receiverUser?.requests?.invitation?.welcomeMessage || "";

        const inviter = await userService.findById(receiverUser.requests.invitation.invitedBy?._id, {logger, languageCode})
        const inviterName = `${inviter.name || ""} ${inviter.surname || ""}`.trim() || inviter.username;

        await receiverUser.sendInvitationEmail(
            welcomeMessage,
            company.name,
            inviterName,
            languageCode,
            company._id,
            session,
            logger
        );
        logger.info(`Invitation email resent to user ${userInfo._id}`);
    }

    logger.finish(`Invitation unlocked for user ${userInfo._id}`);
    return { message: "Invitation lock cleared successfully" };
}

/**
 * PATCH /api/company/users/resendActivationEmail
 *
 * Resends the activation email for a company user.
 * Requires specificUser header with target user id.
 *
 * @route PATCH /api/company/users/resendActivationEmail
 * @access Private
 * @requires Transaction
 * @requires specificUser header (target user id)
 * @requires Write permission for requests.activation.date
 */
router.patch(
    "/resendActivationEmail",
    authMW("private"),
    rateLimiter({ windowMs: 60000, max: 30 }),
    validateFormZod(resendActivationEmailFormSchema),
    transactionHandler(),
    asyncHandler(resendActivationEmail)
);

async function resendActivationEmail(body: AuthenticatedMWType & TransactionRequired): Promise<ResendActivationEmailFormResponseType> {
    const { userInfo, logger, languageCode, actionUserCtx, session, parentBypass } = body;

    if (!parentBypass) {
        throw apiValidationException("user_permissions_not_sufficient", null, null, languageCode);
    }

    if (!userInfo.requests?.activation) {
        throw apiValidationException("activation_not_found", null, null, languageCode);
    }

    const lockedUntil = userInfo.requests.activation.lockedUntil;
    const now = new Date();
    if (lockedUntil && new Date(lockedUntil).getTime() > now.getTime()) {
        throw apiValidationException("activation_link_sent_too_many_times", null, null, languageCode);
    }

    logger.start(`Resending activation email for user ${userInfo._id}`);

    SchemaGuard.sanitizeFields(User, { requests: { keys: { activation: { keys: { date: {} } } } } }, "write", actionUserCtx, languageCode);

    userInfo.$locals = userInfo.$locals || {};
    userInfo.$locals.auditUserId = actionUserCtx.userId;
    await userInfo.sendActivationEmail(userInfo.username, languageCode, session, logger);

    const receiverUser = await userService.findByIdOrThrow(
        userInfo._id,
        { session, logger, languageCode },
        null,
        "requests.activation"
    );

    logger.finish(`Activation email resent to user ${userInfo._id}`);
    return {
        message: "Activation email sent successfully",
        lockedUntil: receiverUser?.requests?.activation?.lockedUntil
    };
}


/**
 * PATCH /api/company/users/resendInvitationEmail
 *
 * Resends the invitation email for a company user.
 * Requires specificUser header with target user id.
 *
 * @route PATCH /api/company/users/resendInvitationEmail
 * @access Private
 * @requires Transaction
 * @requires specificUser header (target user id)
 * @requires Write permission for requests.invitation (attempts, opened, date, invitedAt, invitationExpiresAt, accepted, acceptedAt, invitedBy)
 */
router.patch(
    "/resendInvitationEmail",
    authMW("private"),
    rateLimiter({ windowMs: 60000, max: 30 }),
    validateFormZod(resendInvitationEmailFormSchema),
    transactionHandler(),
    asyncHandler(resendInvitationEmail)
);
async function resendInvitationEmail(body: AuthenticatedMWType & TransactionRequired): Promise<ResendInvitationEmailFormResponseType> {
    const { userInfo, logger, languageCode, actionUserCtx, session, parentBypass, company } = body;

    if (!parentBypass) {
        throw apiValidationException("user_permissions_not_sufficient", null, null, languageCode);
    }

    if ( !(company._id.equals(userInfo.requests?.invitation?.company)) ){
        throw apiValidationException("cannot_unlock_invitation", null, null, languageCode);
    }
    if (!userInfo.requests?.invitation) {
        throw apiValidationException("invitation_not_found", null, null, languageCode);
    }
    if (userInfo.requests.invitation.accepted === true) {
        throw apiValidationException("invitation_already_accepted", null, null, languageCode);
    }

    const lockedUntil = userInfo.requests.invitation.lockedUntil;
    const now = new Date();
    if (lockedUntil && new Date(lockedUntil).getTime() > now.getTime()) {
        throw apiValidationException("invitation_link_sent_too_many_times", null, null, languageCode);
    }

    logger.start(`Resending invitation email for user ${userInfo._id}`);

    SchemaGuard.sanitizeFields(User, {requests: {keys: {invitation: {keys: {invitationExpiresAt: {}}}}}}, "write", actionUserCtx, languageCode);

    const welcomeMessage = userInfo?.requests?.invitation?.welcomeMessage || "";
    const inviter = await userService.findById(userInfo.requests.invitation.invitedBy?._id, {logger, languageCode})
    const inviterName = `${inviter.name || ""} ${inviter.surname || ""}`.trim() || inviter.username;

    await userInfo.sendInvitationEmail(
        welcomeMessage,
        company.name,
        inviterName,
        languageCode,
        company._id,
        session,
        logger
    );

    const receiverUser = await userService.findByIdOrThrow(
        userInfo._id,
        { session, logger, languageCode },
        null,
        "requests.invitation"
    );

    logger.finish(`Invitation email resent to user ${userInfo._id}`);
    return {
        message: "Invitation email sent successfully",
        lockedUntil: receiverUser?.requests?.invitation?.lockedUntil
    };
}

export { router };