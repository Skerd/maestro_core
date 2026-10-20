/**
 * Optional signed-in customer for public chat session start.
 *
 * Chains AFTER `authMW("public")`. When the site sends its login token
 * (`x-auth-token`), the customer behind it is attached as `customer`; otherwise —
 * or when the token does not check out — the request stays anonymous. It never
 * rejects: whether someone is logged in decides who the chat belongs to, not
 * whether they may chat.
 *
 * The handler still has to compare `customer.companyId` with the origin tenant.
 *
 * @module publicChatCustomerMW
 */

import {
    PublicChatCustomer,
    tryResolvePublicChatCustomer,
} from "@coreModule/domain/publicChat/publicChatCustomer";

export type PublicChatCustomerMWType = {
    customer?: PublicChatCustomer,
};

export default () => async (req: any, _res: any, next: any) => {
    const token = req.header("x-auth-token");
    const languageCode = req.body?.languageCode || req.header("language") || "en-US";
    // Always overwritten: the body is client-controlled, so a `customer` posted
    // in it must never survive to the handler.
    req.body.customer = token
        ? (await tryResolvePublicChatCustomer({token, languageCode})) ?? undefined
        : undefined;
    return next();
};
