/**
 * Company-peer impersonation: swap `userInfo` / request identity to another
 * user in the same company. Header-only (`specificUser`); never the form body.
 *
 * Permission: `isAdmin`, or SchemaGuard others-write / others-read on User.name
 * (same “users / others” perspective the panel uses via `useAccess("users", "others")`).
 * Field-level write on the actual route is still enforced by SchemaGuard there.
 */

import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import User from "@coreModule/database/schemas/user/user";
import {userService} from "@coreModule/database/schemas/user/user.service";
import SchemaGuard from "@coreModule/database/security/schemaGuard";
import {JWTTokenType} from "armonia/src/modules/core/api/user/public/login/login.form.response.type";
import {UserContext} from "@coreModule/utilities/types/types";
import {IUser} from "@coreModule/database/schemas/user/user";
import {ICompany} from "@coreModule/database/schemas/company/company";
import {ClientSession} from "mongoose";
import {NextFunction, Request, Response} from "express";
import {requestContext} from "@coreModule/utilities/endpoints/requestContext";

const OBJECT_ID_HEX = /^[a-fA-F0-9]{24}$/;

export function readSpecificUserHeader(req: {header: (name: string) => string | undefined}): string | undefined {
    const raw = req.header("specificUser");
    if (!raw || raw === "undefined") {
        return undefined;
    }
    const trimmed = raw.trim();
    return trimmed === "" ? undefined : trimmed;
}

export function assertMayImpersonateCompanyUser(actionUserCtx: UserContext, languageCode: string): void {
    if (actionUserCtx.isAdmin) {
        return;
    }
    const othersCtx: UserContext = {...actionUserCtx, isSelf: false};
    try {
        SchemaGuard.sanitizeFields(User, {name: {}}, "write", othersCtx, languageCode);
        return;
    } catch {
        // Admins already returned; peers may only have others-read (profile fetch).
    }
    try {
        SchemaGuard.sanitizeFields(User, {name: {}}, "read", othersCtx, languageCode);
    } catch {
        throw apiValidationException("cant_access_this_user", "specificUser", null, languageCode);
    }
}

export type ImpersonationSwap = {
    userInfo: IUser;
    user: JWTTokenType;
    parentBypass: JWTTokenType;
    actionInitializerSuffix: string;
};

export async function loadCompanyPeerForImpersonation(params: {
    specificUserId: string;
    actorToken: JWTTokenType;
    company: ICompany;
    session?: ClientSession;
    languageCode: string;
}): Promise<ImpersonationSwap | null> {
    const {specificUserId, actorToken, company, session, languageCode} = params;
    if (specificUserId === String(actorToken.id)) {
        return null;
    }
    if (!OBJECT_ID_HEX.test(specificUserId)) {
        throw apiValidationException("cant_access_this_user", "specificUser", null, languageCode);
    }

    const foundUserInCompany = await userService.findOne(
        {_id: specificUserId, companies: company._id},
        {session, languageCode},
    );
    if (!foundUserInCompany) {
        throw apiValidationException("cant_access_this_user", "specificUser", null, languageCode);
    }

    return {
        userInfo: foundUserInCompany,
        parentBypass: actorToken,
        user: {
            id: foundUserInCompany._id.toString(),
            company: {
                _id: company._id.toString(),
                name: company.name,
            },
            username: foundUserInCompany.username,
        },
        actionInitializerSuffix: ` -> ${foundUserInCompany._id.toString()}: ${foundUserInCompany.username}`,
    };
}

/**
 * Apply after `authMW("private")`. No-op when the `specificUser` header is absent.
 * Must not run on generic CRUD — only on user-scoped routers (see impersonateUserMW mounts).
 */
export async function impersonateUserMW(req: Request, res: Response, next: NextFunction): Promise<void> {
    const body = req.body;
    const languageCode = body?.languageCode || "en-US";
    try {
        const specificUserId = readSpecificUserHeader(req);
        if (!specificUserId) {
            return next();
        }
        assertMayImpersonateCompanyUser(body.actionUserCtx, languageCode);
        const swap = await loadCompanyPeerForImpersonation({
            specificUserId,
            actorToken: body.user,
            company: body.company,
            session: body.session,
            languageCode,
        });
        if (!swap) {
            return next();
        }
        body.userInfo = swap.userInfo;
        body.actionUserCtx.isSelf = false;
        body.parentBypass = swap.parentBypass;
        body.user = swap.user;
        body.actionInitializer = `${body.actionInitializer || ""}${swap.actionInitializerSuffix}`;
        body.logger?.updateActionInitializer?.(body.actionInitializer);
        return requestContext.run({actionUserCtx: body.actionUserCtx}, () => next());
    } catch (error) {
        next(error);
    }
}
