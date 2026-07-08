/**
 * Authentication Middleware (Convenience Wrapper)
 * 
 * This is a convenience wrapper that chains together focused middleware:
 * - validateTokenMW: Token validation
 * - validateCompanyMW: Company validation
 * - validateRolesMW: Role and permission context
 * - handleImpersonationMW: User impersonation
 * 
 * For more granular control, use the individual middleware directly.
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
    // session: ClientSession;
    deviceId: string,
    userAgent: string,
    requestIp: string,
    requestSource: "panel" | "client"
}
export type AuthenticatedMWType = NotAuthenticatedMWType & {
    user: JWTTokenType,
    parentBypass: JWTTokenType | null,
    singleCompanyId: string,

    userInfo: IUser,
    actionUserInfo: IUser,
    actionUserCtx: UserContext,
    company: ICompany,
}

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

    const origin = (req.headers['x-forwarded-host'] || req.hostname || req.get("Origin") || req.get("Referer") || "").replace(/^https?:\/\//, "")?.split("/")?.shift();

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

        // validate user access
        let user = await userService.findByIdOrThrow(userFromToken.id, {session, languageCode});
        req.body.userInfo = user;
        req.body.actionUserInfo = user;

        // validate company domain
        const company = await companyService.findByIdOrThrow(new ObjectId( actionCompany || userFromToken.company?._id), {session}, [], "allowedDomains name isActive");
        req.body.company = company;
        let isAdmin = await user.isAdmin(company._id);

        if( !company.isActive && !isAdmin ){
            throw apiValidationException("company_is_inactive", "company", null, languageCode);
        }

        await validateActiveUserSession(userFromToken, user._id, company._id, {session, languageCode});

        await user.checkAccountAccessibility(company._id, languageCode);

        // if (!company.allowedDomains.includes("*") && !company.allowedDomains.includes(origin)) {
        //     throw apiActionValidationException("user_does_not_exist", null, null, languageCode);
        // }

        if (! (await user?.hasAtLeastOneRole(company._id)) ) {
            throw apiValidationException("user_must_have_at_least_one_role", "roles", null, languageCode);
        }

        // lets provide context for user and actioUser, at this point they may be the same
        req.body.actionUserCtx = {
            userId: user._id.toString(),
            orgId: company._id.toString(),
            isAdmin: await user.isAdmin(company._id),
            permissions: await user.getCompanyRolePermissions(company._id),
            isSelf: true
        };


        const specificUser = req.body.specificUser || req.header('specificUser');
        // console.log(specificUser, userFromToken.id);
        if (specificUser && specificUser !== "" && specificUser !== "undefined" && specificUser !== userFromToken.id) {

            if( !specificUser || specificUser === "" || specificUser.length !== 24 ){
                throw apiValidationException("cant_access_this_user", "specificUser", null, languageCode);
            }

            // if (!user.registeredFrom && user.username !== "echo") {
            //     throw apiActionValidationException("user_not_registered_from_anybody", null, null, languageCode);
            // }

            // if (user.registeredFrom?.toString() !== user._id.toString()) {
                let foundUserInCompany = await userService.findOne({_id: specificUser, companies: company._id});

                if (!foundUserInCompany) {
                    throw apiValidationException("cant_access_this_user", "specificUser", null, languageCode);
                }
                // if (! (await foundUserInCompany?.hasAtLeastOneRole(company._id) )) {
                //     throw apiValidationException("user_to_access_must_have_at_least_one_role", null, null, languageCode);
                // }

                // TODO does it make sense to not update userInfo at all? since the infra is chaning, no need to do it. the schemaGuard does it for us
                req.body.userInfo = foundUserInCompany;
                req.body.actionUserCtx.isSelf = false;
                // if we go here, it means that

                //  const [currentUserClearance, specificUserClearance] = await Promise.all([
                //      user.getMaxClearanceLevel(new ObjectId(userFromToken.company?._id)),
                //      user.getMaxClearanceLevel(new ObjectId(userFromToken.company?._id))
                //  ]);
                //  if (currentUserClearance <= specificUserClearance) {
                //      throw apiActionValidationException("user_clearance_not_sufficient", null, null, languageCode);
                //  }

                //we now switch places, parentBypass is actually action user, and user is the one we are impersonating
                req.body.parentBypass = userFromToken;
                req.body.user = {
                    id: foundUserInCompany._id,
                    company: {
                        _id: company._id,
                        name: company.name
                    },
                    username: foundUserInCompany.username,
                }
                actionInitializer += ` -> ${foundUserInCompany._id.toString()}: ${foundUserInCompany.username}`;
            // }
        }

        logger.updateActionInitializer(actionInitializer);
        req.body.logger = logger;

        // Run rest of request in context so soft-delete plugin and populate refs see actionUserCtx
        return requestContext.run({ actionUserCtx: req.body.actionUserCtx }, () => next());
    } catch (error: any) {
        logger.start()
        logger.fail(error);
        return res.status(error.status || 400).json({
            error: error.message,
            errorCode: error.error_code,
            extraMessage: error.extra_message,
            content: error.content
        });
    }
};
