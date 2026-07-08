/**
 * User login API – public endpoints for username/password and third-party OAuth authentication.
 *
 * Mounted under the user public routes (e.g. `/api/user/login`). Endpoints are public (no authentication
 * required). Standard login resolves company by origin domain, verifies password and MFA, updates lastLogin
 * and resets unsuccessful attempts, returns JWT tokens (or MFA activation status). Third-party login
 * supports Google and Apple; creates a new user if needed (default company/role). Changes are audited
 * with the user's own ID (self-action).
 *
 * **Routes:**
 * - `POST "/"` – Username/password login; MFA support; returns JWT tokens or MFA activation status.
 * - `POST "/thirdParty"` – Third-party OAuth (Google, Apple); creates user if new; returns JWT tokens.
 *
 * @module f_endpoints/core/user/public/login
 */

import {Response, Router} from "express";
import {LoginFormType} from "armonia/src/modules/core/api/user/public/login/login.form.type";
import authMW, {NotAuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import {asyncHandler} from "@coreModule/utilities/middlewares/asyncHandler";
import {transactionHandler} from "@coreModule/utilities/middlewares/transactionHandler";
import {TransactionRequiredParams} from "@coreModule/utilities/middlewares/transactionUtils";
import {loginFormSchema} from "armonia/src/modules/core/api/user/public/login/login.form.validator";
import {
    LoginFormResponseType,
    MFAEnabledLoginFormResponseType
} from "armonia/src/modules/core/api/user/public/login/login.form.response.type";
import {companyService} from "@coreModule/database/schemas/company/company.service";
import {currencyService} from "@coreModule/database/schemas/currency/currency.service";
import {financeService} from "@coreModule/database/schemas/finance/finance.service";
import {roleService} from "@coreModule/database/schemas/role/role.service";
import {userService} from "@coreModule/database/schemas/user/user.service";
import {ICompany} from "@coreModule/database/schemas/company/company";
import {FinanceCurrencies} from "@coreModule/database/schemas/finance/finance";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import axios from "axios";
import generator from "generate-password";
import {thirdPartyLoginFormSchema} from "armonia/src/modules/core/api/user/public/login/thirdPartyLogin.form.validator";
import {
    AppleUserData,
    ThirdPartyLoginFormType
} from "armonia/src/modules/core/api/user/public/login/thirdPartyLogin.form.type";
import {
    ThirdPartyLoginFormResponseType
} from "armonia/src/modules/core/api/user/public/login/thirdPartyLogin.form.response.type";
import {AUTHENTICATION} from "@coreModule/environment";
import qs from "qs";
import fs from "fs";
import jwt from "jsonwebtoken";
import path from "path";
import {Decimal128, ObjectId} from "mongodb";
import {rateLimiter} from "@coreModule/utilities/middlewares/rateLimiter";
import {validateFormZod} from "@coreModule/utilities/middlewares/validateFormZod";
import {emitNotificationEvent, NotificationEventCodes} from "@coreModule/domain/notifications/notificationEventBus";

const router = Router();

/**
 * POST /api/user/login
 *
 * Authenticates with username and password. Supports MFA; returns JWT tokens or MFA activation status.
 *
 * @route POST /api/user/login
 * @access Public
 * @requires Transaction
 * @body {LoginFormType} - username, password, mfaCode? (optional)
 * @returns {Promise<LoginFormResponseType | MFAEnabledLoginFormResponseType>} JWT token and refreshToken, or { mfaActivated: true }
 *
 * @throws {apiValidationException} If user not found, account not accessible (locked/inactive), password wrong, or MFA code invalid
 *
 * @remarks
 * - Rate limited: 60 requests per minute
 * - Resolves company by origin domain (specific then wildcard); verifies password and MFA
 * - Updates lastLogin, resets unsuccessful attempts, adds login history; returns JWT; audited with user's ID (self-action)
 */
router.post(
    "/",
    authMW("public"),
    rateLimiter({ windowMs: 60000, max: 60 }),
    validateFormZod(loginFormSchema),
    transactionHandler(),
    asyncHandler(Login)
);
/**
 * Resolves company by origin, verifies password and MFA, updates lastLogin and resets attempts, returns JWT (or MFA status). Uses user's ID for audit.
 *
 * @param params - Transaction, form (username, password, mfaCode?), origin, logger, session, languageCode, deviceId, userAgent, requestIp, requestSource.
 * @param queryParams - Query parameters.
 * @param request - Express request (for login history).
 * @param response - Express response.
 * @returns JWT token and refreshToken, or { mfaActivated: true }.
 */
async function Login(
    params: TransactionRequiredParams & NotAuthenticatedMWType & LoginFormType,
    queryParams: any,
    request: any,
    response: Response
): Promise<LoginFormResponseType | MFAEnabledLoginFormResponseType> {

    const { username, password, mfaCode, languageCode, origin, session, logger, deviceId, userAgent, requestIp, requestSource } = params;

    logger.start(`Trying to authenticate user [${username}]...`);

    const user = await userService.findOneOrThrow({ username }, { session, logger, languageCode });
    let company: ICompany;

    try{
        // Find company - prioritize specific origin, then wildcard
        const companyIds = user.companies.map((c: any) => c._id || c);

        // First, try to find company with specific origin
        company = await companyService.findOneOrThrow(
            {
                _id: { $in: companyIds },
                isActive: true,
                $or: [
                    { allowedDomains: { $in: [origin] } },
                    { allowedDomains: "*" }
                ],
            },
            { session, logger, languageCode }
        );

        await user.checkAccountAccessibility(company._id, languageCode);

        // if( !company ){
        //     let companies = await companyService.find(
        //         {
        //             _id: { $in: companyIds },
        //             allowedDomains: "*",
        //             isActive: true
        //         },
        //         { session, logger, languageCode }
        //     );
        //
        //     for( let currCompany of companies ){
        //         try {
        //             await user.checkAccountAccessibility(currCompany._id, languageCode);
        //             company = currCompany;
        //             break;
        //         }
        //         catch (e){}
        //     }
        // }

        if( !company ){
            throw apiValidationException("user_not_active", null, null, languageCode);
        }
        // Verify account accessibility

        // Verify password
        await user.checkPassword(company._id, password, languageCode);

        // Handle MFA
        if (user.isMfaEnabled() && !mfaCode ) {
            logger.finish(`Successfully authenticated user [${username}] but MFA is activated, second step should be completed to log in`);
            return {
                mfaActivated: true
            };
        }

        // Verify MFA code if provided
        if (mfaCode) {
            await user.verifyMfa(company._id, mfaCode, languageCode);
        }

        let foundRole = user.roles.find((role: any) => {
            return role.company.equals(company._id)
        });
        if( !!foundRole ){
           foundRole.lastLogin = new Date();
           // Set auditUserId for self-action (user logging into their own account)
           user.$locals = user.$locals || {};
           user.$locals.auditUserId = user._id;
           await user.save({session});
        }

        // Reset unsuccessful login attempts (sets auditUserId internally via $locals)
        user.$locals = user.$locals || {};
        user.$locals.auditUserId = user._id;
        await user.resetUnsuccessfulLogins(company._id, session);

        await user.addLoginHistory(company._id, request, null);
        const { session: userSessionRow, isNewDevice } = await user.createOrUpdateSession(
            company._id,
            deviceId ?? "",
            userAgent ?? "",
            requestIp ?? "",
            response,
            languageCode
        );

        // Generate JWT token and refresh token
        const { token, refreshToken } = await user.generateJWTToken(company._id, requestSource, userSessionRow._id.toString(), languageCode);

        emitNotificationEvent(NotificationEventCodes.USER_LOGGED_IN, {
            receiverIds: [user._id.toString()],
            payload: {
                companyId: company._id.toString(),
                requestIp: requestIp ?? "",
                userAgent: userAgent ?? "",
                source: requestSource,
                languageCode
            },
            session
        });
        if (isNewDevice) {
            emitNotificationEvent(NotificationEventCodes.USER_LOGGED_IN_NEW_DEVICE, {
                receiverIds: [user._id.toString()],
                payload: {
                    companyId: company._id.toString(),
                    requestIp: requestIp ?? "",
                    userAgent: userAgent ?? "",
                    source: requestSource,
                    languageCode
                },
                session
            });
        }

        logger.finish(`Successfully authenticated user [${username}]!`);

        return { token, refreshToken } as LoginFormResponseType;

    }catch (e){
        await user.addLoginHistory(company?._id ?? new ObjectId("000000000000000000000000"), request, e);
        throw (e);
    }

}


/**
 * POST /api/user/login/thirdParty
 *
 * Authenticates via Google or Apple OAuth. Creates a new user if the email is not registered.
 *
 * @route POST /api/user/login/thirdParty
 * @access Public
 * @requires Transaction
 * @body {ThirdPartyLoginFormType} - code, platform (google | apple), appleUserData? (for Apple)
 * @returns {Promise<ThirdPartyLoginFormResponseType>} JWT token and refreshToken
 *
 * @throws {apiValidationException} If third-party login disabled, OAuth fails, default company/role missing (new user), or account not accessible
 *
 * @remarks
 * - Rate limited: 20 requests per minute
 * - Resolves company by origin; creates user with default company/role if new; verifies accessibility, resets attempts; returns JWT; audited with user's ID
 */
router.post(
    "/thirdParty",
    authMW("public"),
    rateLimiter({ windowMs: 60000, max: 20 }),
    validateFormZod(thirdPartyLoginFormSchema),
    transactionHandler(),
    asyncHandler(LoginThirdParty)
);
/**
 * Exchanges OAuth code for user info, finds or creates user, resolves company by origin, verifies accessibility, returns JWT. Uses user's ID for audit.
 *
 * @param params - Transaction, form (code, platform, appleUserData?), origin, logger, session, languageCode, deviceId, userAgent, requestIp, requestSource.
 * @param queryParams - Query parameters.
 * @param request - Express request (for login history/session).
 * @param response - Express response.
 * @returns JWT token and refreshToken.
 */
async function LoginThirdParty(
    params: TransactionRequiredParams & NotAuthenticatedMWType & ThirdPartyLoginFormType,
    queryParams: any,
    request: any,
    response: Response
): Promise<ThirdPartyLoginFormResponseType> {
    const {
        code,
        platform,
        appleUserData,
        languageCode,
        origin,
        session,
        logger,
        deviceId,
        userAgent,
        requestIp,
        requestSource
    } = params;

    logger.start(`Trying to authenticate user via third party [${platform}]...`);

    if( !AUTHENTICATION.ACTIVATE_GOOGLE_LOGIN && !AUTHENTICATION.ACTIVATE_APPLE_LOGIN ) {
        throw apiValidationException("third_party_login_not_allowed", null, null, languageCode);
    }

    let userInfo: {
        email: string;
        name: string;
        surname: string;
        sub: string;
    };

    // const googleParams = new URLSearchParams({
    //     client_id: process.env.GOOGLE_CLIENT_ID!,
    //     redirect_uri: process.env.GOOGLE_REDIRECT_URL!,
    //     response_type: 'code',
    //     scope: [
    //         'openid',
    //         'profile',
    //         'email'
    //     ].join(' '),
    //     access_type: 'offline', // gets refresh token
    //     prompt: 'consent'       // forces consent screen
    // });
    // const googleAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?${googleParams.toString()}`;
    // console.log(googleAuthUrl);
    //
    // const appleParams = new URLSearchParams({
    //     response_type: "code",
    //     response_mode: "form_post",             // IMPORTANT, otherwise you won't get ?code=...
    //     client_id: process.env.APPLE_CLIENT_ID!,  // Service ID
    //     redirect_uri: process.env.APPLE_REDIRECT_URL!,
    //     scope: "name email",                // Apple only supports these 2
    // });
    // const appleAuthUrl = `https://appleid.apple.com/auth/authorize?${appleParams.toString()}`;
    // console.log(appleAuthUrl);

    try {
        if (platform === "google") {
            userInfo = await authenticateWithGoogle(code, languageCode);
        } else if (platform === "apple") {
            userInfo = await authenticateWithApple(code, appleUserData, languageCode);
        } else {
            throw apiValidationException("unsupported_third_party_platform", null, null, languageCode);
        }
    } catch (error: any) {
        logger.err(`Failed to authenticate with ${platform}: ${error.message}`);
        throw apiValidationException("third_party_login_failed", null, null, languageCode);
    }

    // const username = `${userInfo.name}#${userInfo.sub}`;
    const password = `${platform}Password@10${generator.generate({ length: 32, numbers: true, strict: true })}`;

    // Find or create user
    let user = await userService.findOne({ username: userInfo.email }, { session, logger, languageCode });

    if (!user) {
        // Create a new user account
        user = await createThirdPartyUser(
            {
                email: userInfo.email,
                password,
                name: userInfo.name || "-",
                surname: userInfo.surname || "-"
            },
            { session, logger, languageCode }
        );
    }

    let company: ICompany;
    try {

        // Get user profile and find company
        const companyIds = user.companies.map((c: any) => c._id || c);

        try {
            // First, try to find company with specific origin
            company = await companyService.findOneOrThrow(
                {
                    _id: { $in: companyIds },
                    allowedDomains: origin,
                    isActive: true
                },
                { session, logger, languageCode }
            );
        } catch (error) {
            // If not found, fall back to wildcard
            company = await companyService.findOneOrThrow(
                {
                    _id: { $in: companyIds },
                    allowedDomains: "*",
                    isActive: true
                },
                { session, logger, languageCode }
            );
        }

        // Verify account accessibility
        await user.checkAccountAccessibility(company._id, languageCode);

        // Reset unsuccessful login attempts (sets auditUserId internally via $locals)
        user.$locals = user.$locals || {};
        user.$locals.auditUserId = user._id;
        await user.resetUnsuccessfulLogins(company._id, session);

        await user.addLoginHistory(company._id, request, null);

        const { session: userSessionRow, isNewDevice } = await user.createOrUpdateSession(
            company._id,
            deviceId ?? "",
            userAgent ?? "",
            requestIp ?? "",
            response,
            languageCode
        );

        // Generate JWT token and refresh token
        const { token, refreshToken } = await user.generateJWTToken(company._id, requestSource, userSessionRow._id.toString(), languageCode);

        emitNotificationEvent(NotificationEventCodes.USER_LOGGED_IN, {
            receiverIds: [user._id.toString()],
            payload: {
                companyId: company._id.toString(),
                requestIp: requestIp ?? "",
                userAgent: userAgent ?? "",
                source: requestSource,
                languageCode
            },
            session
        });
        if (isNewDevice) {
            emitNotificationEvent(NotificationEventCodes.USER_LOGGED_IN_NEW_DEVICE, {
                receiverIds: [user._id.toString()],
                payload: {
                    companyId: company._id.toString(),
                    requestIp: requestIp ?? "",
                    userAgent: userAgent ?? "",
                    source: requestSource,
                    languageCode
                },
                session
            });
        }

        logger.finish(`Successfully authenticated user [${userInfo.email}] via ${platform}!`);

        return { token, refreshToken };
    } catch (e) {
        await user.addLoginHistory(company?._id ?? new ObjectId("000000000000000000000000"), request, e);
        throw e;
    }
}

/**
 * Authenticate with Google OAuth
 *
 * @param code - OAuth authorization code from Google
 * @param languageCode - Language code for error messages
 * @returns User information from Google
 */
async function authenticateWithGoogle(
    code: string,
    languageCode: string
): Promise<{ email: string; name: string; surname: string; sub: string }> {

    const CLIENT_ID = AUTHENTICATION.GOOGLE_CLIENT_ID;
    const CLIENT_SECRET = AUTHENTICATION.GOOGLE_CLIENT_SECRET;
    const REDIRECT_URL = AUTHENTICATION.GOOGLE_REDIRECT_URL;

    if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URL) {
        throw apiValidationException("google_oauth_config_missing", null, null, languageCode);
    }

    // Exchange authorization code for an access token
    const tokenResponse = await axios.post(
        'https://oauth2.googleapis.com/token',
        qs.stringify({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            code: decodeURIComponent(code),
            redirect_uri: REDIRECT_URL,
            grant_type: "authorization_code"
        }),
        {
            headers: { "Content-Type": "application/x-www-form-urlencoded" }
        }
    );

    // Get user information
    const userInfoResponse = await axios.get('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: {
            Authorization: `Bearer ${tokenResponse.data.access_token}`
        }
    });

    return {
        email: userInfoResponse.data.email,
        name: userInfoResponse.data.given_name || "",
        surname: userInfoResponse.data.family_name || "",
        sub: userInfoResponse.data.sub
    };
}

/**
 * Authenticate with Apple OAuth
 *
 * @param code - OAuth authorization code from Apple
 * @param appleUserData
 * @param languageCode - Language code for error messages
 * @returns User information from Apple
 */
async function authenticateWithApple(
    code: string,
    appleUserData: AppleUserData,
    languageCode: string
): Promise<{ email: string; name: string; surname: string; sub: string }> {

    const KEY_ID = AUTHENTICATION.APPLE_KEY_ID;
    const CLIENT_ID = AUTHENTICATION.APPLE_CLIENT_ID;         // Services ID
    const APPLE_TEAM_ID = AUTHENTICATION.APPLE_TEAM_ID;
    const REDIRECT_URL = AUTHENTICATION.APPLE_REDIRECT_URL;
    const APPLE_PRIVATE_KEY_PATH = AUTHENTICATION.APPLE_PRIVATE_KEY_PATH; // path to .p8 file

    if (!CLIENT_ID || !KEY_ID || !APPLE_TEAM_ID || !REDIRECT_URL || !APPLE_PRIVATE_KEY_PATH) {
        throw apiValidationException("apple_oauth_config_missing", null, null, languageCode);
    }

    // Load private key
    const privateKey = fs.readFileSync(path.join(__dirname, `../../../../${APPLE_PRIVATE_KEY_PATH}`), "utf8");

    // Create Apple client_secret (JWT)
    const CLIENT_SECRET = jwt.sign(
        {
            iss: APPLE_TEAM_ID,
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 86400 * 180,
            aud: "https://appleid.apple.com",
            sub: CLIENT_ID
        },
        privateKey,
        {
            algorithm: "ES256",
            header: { kid: KEY_ID }
        } as jwt.SignOptions  // ← the critical fix
    );

    // Exchange authorization code for access token
    const tokenResponse = await axios.post(
        "https://appleid.apple.com/auth/token",
        new URLSearchParams({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            code,
            redirect_uri: REDIRECT_URL,
            grant_type: "authorization_code"
        }).toString(),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    const idToken = tokenResponse.data.id_token;
    if (!idToken) {
        throw apiValidationException("apple_id_token_missing", null, null, languageCode);
    }

    // Decode ID token (Apple JWT)
    const payload = JSON.parse(
        Buffer.from(idToken.split(".")[1], "base64").toString()
    );

    const email = payload.email || "";
    const sub = payload.sub;

    // Apple ONLY gives name/surname on the first login (frontend must send it)
    const name = payload.name?.firstName || appleUserData.name.firstName || "";
    const surname = payload.name?.lastName || appleUserData.name.lastName || "";

    return { email, name, surname, sub };
}

/**
 * Create a new user account for third-party authentication
 *
 * @param userData - User data from third-party provider
 * @param options - CRUD options including session, logger, and languageCode
 * @returns Created user document
 */
async function createThirdPartyUser(
    userData: {
        email: string;
        password: string;
        name: string;
        surname: string;
    },
    options: { session: any; logger: any; languageCode: string }
): Promise<any> {
    const { session, logger, languageCode } = options;

    // Find default company for signup
    const company = await companyService.findOne(
        { isDefaultForSignUp: true },
        { session, logger, languageCode }
    );

    if (!company) {
        throw apiValidationException("default_sign_up_company_not_found", null, null, languageCode);
    }

    // Find default role
    const defaultRole = await roleService.findOne(
        { company: company._id, isSignupDefault: true },
        { session, logger, languageCode }
    );

    if (!defaultRole) {
        throw apiValidationException("default_sign_up_company_role_not_found", null, null, languageCode);
    }

    // Company role will be embedded in user document

    // Generate user ID first so we can use it for audit logging
    const newUserId = new ObjectId();

    // Create finance currencies
    const currencies = await currencyService.find({}, { session, logger, languageCode });
    const financeCurrencies: FinanceCurrencies[] = currencies.map((currency) => ({
        currency: currency,
        amount: Decimal128.fromString("0"),
    }));

    // Create finance record (use new user's ID as actor for self-service account creation)
    const newFinance = await financeService.create(
        {
            currencies: financeCurrencies,
            transactions: [],
            company: company._id
        } as any,
        { session, logger, languageCode, auditUserId: newUserId.toString() }
    );

    // Create embedded company role object
    const companyRoleData = {
        active: "active",
        unsuccessfulLogins: 0,
        lockedOutUntil: null,
        lastLogin: null,
        roles: [defaultRole._id],
        company: company._id
    };

    // Create user account (active immediately for third-party auth)
    // Use new user's own ID as actor for audit logging (self-action for account creation)
    const newUser = await userService.create(
        {
            _id: newUserId,
            username: userData.email,
            password: userData.password,
            mfaSecret: "",
            online: false,
            isEmailVerified: true,
            emailVerifiedAt: new Date(),

            name: userData.name,
            surname: userData.surname,
            email: userData.email,
            verifiedEmail: true,
            timezone: "Europe/Berlin",
            birthday: new Date(),
            phoneNumber: "+000000000000",
            companies: [company._id],
            finance: [newFinance._id],
            roles: [companyRoleData]
        } as any,
        { session, logger, languageCode, auditUserId: newUserId.toString() }
    );

    return newUser;
}


export { router };
