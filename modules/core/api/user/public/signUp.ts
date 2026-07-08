/**
 * User signup API – public endpoint for creating new user accounts with default company and role.
 *
 * Mounted under the user public routes (e.g. `/api/user/signup`). Public (no authentication
 * required). Creates user with default company (isDefaultForSignUp) and default role (isSignupDefault),
 * finance record with zero balance, and sends activation email; user must activate before logging in.
 * All changes are audited with the new user's own ID (self-action).
 *
 * **Routes:**
 * - `POST ""` – Create new user with default company/role; send activation email.
 *
 * @module f_endpoints/core/user/public/signUp
 */

import {Router} from "express";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import authMW, {NotAuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import {signupFormSchema} from "armonia/src/modules/core/api/user/public/signUp/signup.form.validator";
import {asyncHandler} from "@coreModule/utilities/middlewares/asyncHandler";
import {SignUpFormType} from "armonia/src/modules/core/api/user/public/signUp/signup.form.type";
import {FinanceCurrencies} from "@coreModule/database/schemas/finance/finance";
import {companyService} from "@coreModule/database/schemas/company/company.service";
import {currencyService} from "@coreModule/database/schemas/currency/currency.service";
import {financeService} from "@coreModule/database/schemas/finance/finance.service";
import {roleService} from "@coreModule/database/schemas/role/role.service";
import {userService} from "@coreModule/database/schemas/user/user.service";
import {transactionHandler} from "@coreModule/utilities/middlewares/transactionHandler";
import {TransactionRequiredParams} from "@coreModule/utilities/middlewares/transactionUtils";
import {Decimal128, ObjectId} from "mongodb";
import {rateLimiter} from "@coreModule/utilities/middlewares/rateLimiter";
import {validateFormZod} from "@coreModule/utilities/middlewares/validateFormZod";
import {SignupFormResponseType} from "armonia/src/modules/core/api/user/public/signUp/signup.form.response.type";

/** Default timezone for new signup users (aligned with company user creation). */
const DEFAULT_NEW_USER_TIMEZONE = "Europe/Tirane";

const router = Router();

/**
 * POST /api/user/signup
 *
 * Creates a new user account with default company and role. Sends activation email; user must activate before logging in.
 *
 * @route POST /api/user/signup
 * @access Public
 * @requires Transaction
 * @body {SignUpFormType} - email, password, name, surname
 * @returns {Promise<{message: string}>} Success message
 *
 * @throws {apiValidationException} If user with same email exists, or default signup company/role not found
 *
 * @remarks
 * - Rate limited: 10 requests per minute
 * - Creates user, finance (zero balance), and company role; sends activation email; audited with new user's ID (self-action)
 */
router.post(
    "",
    authMW("public"),
    rateLimiter({ windowMs: 60000, max: 10 }),
    validateFormZod(signupFormSchema),
    transactionHandler(),
    asyncHandler(SignUp)
);
/**
 * Creates new user with default company and role, finance record, and sends activation email.
 * Uses new user's own ID for audit (self-action).
 *
 * @param params - Transaction, form (email, password, name, surname), logger, languageCode, session.
 * @returns Success message.
 */
async function SignUp(params: TransactionRequiredParams & NotAuthenticatedMWType & SignUpFormType): Promise<SignupFormResponseType> {

    const {email, password, name, surname, languageCode, session, logger} = params;

    logger.start(`Trying to sign user up ${email}...`);

    if (await userService.findOne({username: email}, {session, logger, languageCode})) {
        throw apiValidationException("user_with_same_username_already_exists", null, null, languageCode);
    }

    let company = await companyService.findOne({isDefaultForSignUp: true}, {session, logger, languageCode});
    if( !company ){
        throw apiValidationException("default_sign_up_company_not_found", null, null, languageCode);
    }

    let defaultRole = await roleService.findOne({company: company._id, isSignupDefault: true}, {session, logger, languageCode});
    if( !defaultRole ){
        throw apiValidationException("default_sign_up_company_role_not_found", null, null, languageCode);
    }

    // Create embedded company role object
    const companyRoleData = {
        active: "active",
        unsuccessfulLogins: 0,
        lockedOutUntil: null,
        lastLogin: null,
        rolesCount: 1,
        roles: [defaultRole._id],
        company: company._id,
        _id: new ObjectId()
    };

    let financeCurrencies: FinanceCurrencies[] = (await currencyService.find({}, {session, logger, languageCode})).map( currency => {
        return {
            currency: currency._id,
            amount: Decimal128.fromString("0.0")
        }
    });

    // Generate user ID first so we can use it for audit logging
    const newUserId = new ObjectId();
    
    let financeIds = [];
    // Create finance record (use new user's ID as actor for self-service account creation)
    // Include transactions: [] to match company user creation shape
    let newFinance = await financeService.create({
        currencies: financeCurrencies,
        transactions: [],
        company: company._id
    } as any, {session, logger, languageCode, auditUserId: newUserId.toString()});
    financeIds.push(newFinance._id);

    // Create user account (use new user's own ID as actor - self-action for account creation)
    let createdUser = await userService.create({
        _id: newUserId,
        username: email,
        password: password,
        mfaSecret: "",
        registeredFrom: newUserId,
        online: false,
        name: name,
        surname: surname,
        fullName: `${name} ${surname}`,
        timezone: DEFAULT_NEW_USER_TIMEZONE,
        birthday: new Date(),
        phoneNumber: "",
        companies: [company._id],
        finance: financeIds,
        roles: [companyRoleData],
        isEmailVerified: false,
        "requests.activation": {
            date: Date.now()
        }
    } as any, {session, logger, languageCode, auditUserId: newUserId.toString()});

    // Set auditUserId for self-action (new user requesting activation email for their own account)
    createdUser.$locals = createdUser.$locals || {};
    createdUser.$locals.auditUserId = createdUser._id;
    await createdUser.sendActivationEmail(email, languageCode, session, logger);

    logger.finish(`Successfully signed user up [${email}]!`);
    return {message: "User signed up successfully!"};
}

const functions = {}
module.exports = {router, functions};
