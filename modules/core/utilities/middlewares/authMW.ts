/**
 * Private-route authentication: JWT, company, session, and role context.
 *
 * Impersonation is not applied here. User-scoped routers mount `impersonateUserMW`
 * after this middleware. The `specificUser` form field is ignored everywhere.
 */

import {IUser} from "@coreModule/database/schemas/user/user";
import {ICompany} from "@coreModule/database/schemas/company/company";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {JWTTokenType} from "armonia/src/modules/core/api/user/public/login/login.form.response.type";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {companyService} from "@coreModule/database/schemas/company/company.service";
import {userService} from "@coreModule/database/schemas/user/user.service";
import {UserContext} from "@coreModule/utilities/types/types";
import {ObjectId} from "mongodb";
import {validateJWTToken} from "@coreModule/utilities/security/jwtValidator";
import {requestContext} from "@coreModule/utilities/endpoints/requestContext";
import {validateActiveUserSession} from "@coreModule/utilities/security/sessionValidator";

export type NotAuthenticatedMWType = {
    apiCode: string,
    languageCode: string,
    actionInitializer: string,
    origin: string,
    logger: serverLogger,
    deviceId: string,
    userAgent: string,
    requestIp: string,
    requestSource: "panel" | "client"
}

export type Authenticated = {
    user: JWTTokenType,
    parentBypass: JWTTokenType | null,
    singleCompanyId: string,

    userInfo: IUser,
    actionUserInfo: IUser,
    actionUserCtx: UserContext,
    company: ICompany,
}

/**
 * Auth context after `authMW("private")`. Keep this separate from the Zod form type.
 *
 * Convention for **new** handlers only: `params: AuthenticatedMWType & SomeFormType`
 * (canonical: `maestro/modules/propertyManagement/api/realEstate/private/dashboard.ts`).
 * Do not fold form fields into this type. Do not rewrite `createCrudRouter`.
 */
export type AuthenticatedMWType = NotAuthenticatedMWType & Authenticated;

export default (type: "public" | "private") => async (req: any, res: any, next: any) => {

    const isPublic = type === "public";
    const token = req.header('x-auth-token');
    const actionCompany = req.header('x-company-id');
    const deviceId = req.header('x-device-id');
    const userAgent = req.header('User-Agent');
    const languageCode = req.header("language") || "en-US";
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    let requestIp = Array.isArray(ip) ? ip[0] : ip;
    let logger: serverLogger = getLogger(req.originalUrl);
    const session = req.session;

    const originHeader = (req.get("Origin") || req.get("Referer") || "").replace(/^https?:\/\//, "")?.split("/")?.shift();
    const origin = originHeader || (req.app?.get("trust proxy") ? req.hostname : "") || "";

    let actionInitializer = "anonymous";
    req.body.apiCode = req.originalUrl;
    req.body.deviceId = deviceId;
    req.body.userAgent = userAgent;
    req.body.requestIp = requestIp;
    req.body.origin = origin;
    req.body.languageCode = languageCode;
    req.body.requestSource = req.header('source') || "client";

    try {
        logger.updateActionInitializer(actionInitializer);
        logger.updateServer("API");
        if (isPublic) {
            req.body.logger = logger;
            return next();
        }

        if (!token) {
            throw apiValidationException("no_token", "token", null, languageCode);
        }

        const userFromToken = validateJWTToken(token, languageCode);
        req.body.user = userFromToken;
        req.body.parentBypass = null;
        actionInitializer = `${userFromToken.username}: ${userFromToken.id}`;
        req.body.actionInitializer = actionInitializer;
        req.body.singleCompanyId = userFromToken.company._id;

        let user = await userService.findByIdOrThrow(userFromToken.id, {session, languageCode});
        req.body.userInfo = user;
        req.body.actionUserInfo = user;

        const company = await companyService.findByIdOrThrow(new ObjectId( actionCompany || userFromToken.company?._id), {session}, [], "name isActive");
        req.body.company = company;
        const {isAdmin, permissions} = await user.getCompanyAccess(company._id);

        if( !company.isActive && !isAdmin ){
            throw apiValidationException("company_is_inactive", "company", null, languageCode);
        }

        await validateActiveUserSession(userFromToken, user._id, company._id, {session, languageCode});

        await user.checkAccountAccessibility(company._id, languageCode);

        if (! (await user?.hasAtLeastOneRole(company._id)) ) {
            throw apiValidationException("user_must_have_at_least_one_role", "roles", null, languageCode);
        }

        req.body.actionUserCtx = {
            userId: user._id.toString(),
            orgId: company._id.toString(),
            isAdmin,
            permissions,
            isSelf: true
        };

        logger.updateActionInitializer(actionInitializer);
        req.body.logger = logger;

        return requestContext.run({ actionUserCtx: req.body.actionUserCtx }, () => next());
    } catch (error: any) {
        logger.start()
        logger.fail(error);
        return next(error);
    }
};
