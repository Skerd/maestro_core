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
import {setRequestTenant} from "@coreModule/utilities/endpoints/tenantScope";
import {validateActiveUserSession} from "@coreModule/utilities/security/sessionValidator";
import {effectiveCompanyModules, isModuleEnabledForCompany} from "@coreModule/utilities/modules/companyModules";
import {getEnabledModuleNames} from "@coreModule/utilities/modules/enabledModules";
import {STUDIO_SAMPLE_HEADER, wantsStudioSample} from "@coreModule/utilities/modules/modelModules";
import {companyTimeZone} from "@coreModule/utilities/time/companyTimeZone";
import {portalBuyerTargetHasModule, type PortalBuyerTarget} from "@coreModule/utilities/security/portalBuyer";
import {resolveMemberCompany, type MemberCompanyAction} from "@coreModule/utilities/security/memberCompany";
import {isPortalZoneOrigin} from "@coreModule/utilities/marketing/portalOrigin";

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
    /** The company's IANA zone for "today" (D116): `companyTimeZone(company)`. `validateFormZod` hands it to Zod factories. */
    companyTimeZone: string,
}

/**
 * Auth context after `authMW("private")`. Keep this separate from the Zod form type.
 *
 * Convention for **new** handlers only: `params: AuthenticatedMWType & SomeFormType`
 * (canonical: `maestro/modules/propertyManagement/api/realEstate/private/dashboard.ts`).
 * Do not fold form fields into this type. Do not rewrite `createCrudRouter`.
 */
export type AuthenticatedMWType = NotAuthenticatedMWType & Authenticated;

export type AuthMWOptions = {
    /**
     * A portal buyer route (D143): for a request from the portal zone, the route's module is checked on the company
     * this names (where the buyer's record lives) when the buyer's own company does not have it.
     */
    portalBuyer?: PortalBuyerTarget;
    /**
     * A member-company action (D172): a portal-zone request that names `actAs` in its body runs this one action for
     * that company of the signed-in user, checked by `resolveMemberCompany`; the session stays the portal's.
     */
    memberCompany?: MemberCompanyAction;
};

export default (type: "public" | "private", options: AuthMWOptions = {}) => async (req: any, res: any, next: any) => {

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
    let origin = originHeader || (req.app?.get("trust proxy") ? req.hostname : "") || "";

    if( origin.includes(":") ){
        origin = origin.split(":")[0];
    }

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
            // Read by resolveCompanyByOrigin, which only honours it on the portal origin.
            const siteCompany = req.header('x-site-company') || undefined;
            return requestContext.run({...requestContext.getStore(), siteCompany}, () => next());
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

        const company = await companyService.findByIdOrThrow(new ObjectId( actionCompany || userFromToken.company?._id), {session}, [], "name isActive modules isPlatformOwner timezone");
        req.body.company = company;
        req.body.companyTimeZone = companyTimeZone(company);
        // From here on the request works on this company's data (D16); the checks below are about it.
        setRequestTenant(company._id, languageCode);
        const studioSample = wantsStudioSample(req.header(STUDIO_SAMPLE_HEADER));
        const modules = studioSample ? getEnabledModuleNames() : effectiveCompanyModules(company);
        const {isAdmin, permissions} = await user.getCompanyAccess(company._id, modules);

        if( !company.isActive && !isAdmin ){
            throw apiValidationException("company_is_inactive", "company", null, languageCode);
        }

        await validateActiveUserSession(userFromToken, user._id, company._id, {session, languageCode});

        await user.checkAccountAccessibility(company._id, languageCode);

        if (! (await user?.hasAtLeastOneRole(company._id)) ) {
            throw apiValidationException("user_must_have_at_least_one_role", "roles", null, languageCode);
        }

        const routeModule = requestContext.getStore()?.routeModule;
        const member = options.memberCompany && isPortalZoneOrigin(origin) && req.body.actAs != null
            ? await resolveMemberCompany(user, req.body.actAs, options.memberCompany, routeModule, languageCode)
            : null;
        if (member) {
            // The request now works on the member company's data, with the user's access there (D16, D172).
            req.body.company = member.company;
            req.body.companyTimeZone = companyTimeZone(member.company);
            setRequestTenant(member.company._id, languageCode);
            logger.info(`Portal session acts for member company ${member.company._id.toString()} (${options.memberCompany?.method})`);
        } else if (routeModule && !studioSample && !isModuleEnabledForCompany(company, routeModule)
            && !(await portalBuyerTargetHasModule(options.portalBuyer, {body: req.body, params: req.params ?? {}}, origin, routeModule))) {
            throw apiValidationException("module_not_enabled", "module", null, languageCode);
        }

        req.body.actionUserCtx = {
            userId: user._id.toString(),
            orgId: (member?.company ?? company)._id.toString(),
            isAdmin: member?.isAdmin ?? isAdmin,
            permissions: member?.permissions ?? permissions,
            isSelf: true,
            modules: member?.modules ?? modules,
        };

        logger.updateActionInitializer(actionInitializer);
        req.body.logger = logger;

        return requestContext.run({
            ...requestContext.getStore(),
            actionUserCtx: req.body.actionUserCtx,
            studioSample,
            ...(studioSample ? {crossTenantReason: "studio preview samples any company's documents"} : {}),
        }, () => next());
    } catch (error: any) {
        logger.start()
        logger.fail(error);
        return next(error);
    }
};
