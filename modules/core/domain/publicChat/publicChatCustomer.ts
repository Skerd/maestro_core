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
import type {serverLogger} from "@coreModule/loggers/serverLog";

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
