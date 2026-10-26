/**
 * Signed-in customers on a public site.
 *
 * A storefront customer chatting while logged in is still served through the
 * visitor machinery — a role-less visitor user owns the channel and holds the
 * visitor token — but the conversation is *linked* to their account
 * (`publicChat.customer`). That link is what labels the chat with their name in
 * the agent inbox and lets them pick the same conversation up on another device.
 *
 * The account never joins the channel: granting a real company user membership
 * of a visitor channel would route it through every member-based code path
 * (inbox, unread counts, erasure) that assumes the visitor is the only outsider.
 *
 * @module publicChatCustomer
 */

import {ObjectId} from "mongodb";
import {validateJWTToken} from "@coreModule/utilities/security/jwtValidator";
import {validateActiveUserSession} from "@coreModule/utilities/security/sessionValidator";
import {userService} from "@coreModule/database/schemas/user/user.service";
import {channelService} from "@coreModule/database/schemas/channel/channel.service";
import {IChannel} from "@coreModule/database/schemas/channel/channel";
import {IUser} from "@coreModule/database/schemas/user/user";
import type {ICompany} from "@coreModule/database/schemas/company/company";
import type {serverLogger} from "@coreModule/loggers/serverLog";
import {companyService} from "@coreModule/database/schemas/company/company.service";
import {isPortalOrigin} from "@coreModule/utilities/marketing/platformShopOrigin";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";

export interface PublicChatCustomer {
    user: IUser;
    /** Company the customer's session was issued for. */
    companyId: ObjectId;
}

/**
 * Resolve a site login token into the customer behind it, with the same checks
 * `authMW("private")` applies (live session, company role, not locked out).
 *
 * Never throws: a missing, expired or foreign token simply means the visitor is
 * chatting anonymously, which must not stop the chat from opening.
 */
export async function tryResolvePublicChatCustomer(params: {
    token: string;
    languageCode: string;
}): Promise<PublicChatCustomer | null> {
    const {token, languageCode} = params;
    try {
        const payload = validateJWTToken(token, languageCode);
        const companyId = new ObjectId(payload.company._id);
        const user = await userService.findOne(
            {_id: new ObjectId(payload.id), isVisitor: {$ne: true}},
            {withDeleted: false, languageCode},
        );
        if (!user) {
            return null;
        }
        await validateActiveUserSession(payload, user._id, companyId, {languageCode});
        await user.checkAccountAccessibility(companyId, languageCode);
        return {user, companyId};
    }
    catch {
        return null;
    }
}

/**
 * The signed-in customer a public request may act as for `company`. Their session must be
 * for that company, or, on the portal only, for the platform owner (portal accounts
 * belong to it). Company sites never accept another company's accounts.
 */
export async function publicCustomerFor(
    customer: PublicChatCustomer | undefined,
    company: ICompany,
    origin: string,
): Promise<IUser | undefined> {
    if (!customer) return undefined;
    if (customer.companyId.equals(company._id as ObjectId)) return customer.user;
    if (!isPortalOrigin(origin)) return undefined;
    const platformAccount = await companyService.findOne({_id: customer.companyId, isPlatformOwner: true, isActive: true});
    return platformAccount ? customer.user : undefined;
}

/**
 * The portal account behind a portal request: signed in, and belonging to the platform
 * owner. Anything else (another origin, no or a company account) is refused.
 */
export async function requirePortalAccount(
    customer: PublicChatCustomer | undefined,
    origin: string,
    languageCode: string,
): Promise<IUser> {
    const platform = isPortalOrigin(origin) && customer
        ? await companyService.findOne({_id: customer.companyId, isPlatformOwner: true, isActive: true})
        : null;
    if (!platform || !customer) {
        throw apiValidationException("no_token", "token", null, languageCode);
    }
    return customer.user;
}

/** The customer's most recent conversation that is still open, if any. */
export async function findOpenCustomerChat(params: {
    companyId: ObjectId;
    customerId: ObjectId;
    languageCode: string;
    logger?: serverLogger;
}): Promise<IChannel | null> {
    const {companyId, customerId, languageCode, logger} = params;
    const [channel] = await channelService.find(
        {
            company: companyId,
            isPublicChat: true,
            "publicChat.customer": customerId,
            "publicChat.status": {$ne: "closed"},
        },
        {logger, languageCode},
        undefined,
        undefined,
        {lastAction: -1},
        1,
    );
    return channel ?? null;
}
