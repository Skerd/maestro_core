/**
 * Public-chat visitor authentication middleware.
 *
 * Chains AFTER `authMW("public")` (which populates origin/logger/languageCode)
 * and upgrades an anonymous public request into one bound to a specific visitor
 * and a specific chat channel.
 *
 * Every request re-checks the full chain rather than trusting the token alone,
 * because a visitor token is long-lived (30d) and has no session to revoke:
 *
 *   1. the token is genuinely a visitor token (see {@link validateVisitorToken});
 *   2. the visitor user still exists, is still `isVisitor`, and is not deleted;
 *   3. the channel still exists, is still a public chat, and is not closed;
 *   4. the channel belongs to the company the token names AND to the company the
 *      request origin resolves to — a token minted on one tenant's site cannot
 *      be replayed against another tenant.
 *
 * @module visitorAuthMW
 */

import {NotAuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {resolveVisitorSession} from "@coreModule/domain/publicChat/visitorSession";
import {IChannel} from "@coreModule/database/schemas/channel/channel";
import {ICompany} from "@coreModule/database/schemas/company/company";
import {IUser} from "@coreModule/database/schemas/user/user";

/** Header the public chat widget sends its visitor token in. */
export const VISITOR_TOKEN_HEADER = "x-visitor-token";

export type VisitorAuthenticatedMWType = NotAuthenticatedMWType & {
    visitorUser: IUser,
    visitorChannel: IChannel,
    visitorCompany: ICompany,
};

/**
 * Re-exported so endpoints that accept an *optional* token (notably session
 * start, which mints one when absent) use the exact same verification path.
 * The implementation lives in `domain/publicChat/visitorSession` because the
 * WebSocket server needs it too.
 */
export {resolveVisitorSession as resolveVisitorContext};

/**
 * Express middleware requiring a valid visitor token. Attaches
 * `visitorUser` / `visitorChannel` / `visitorCompany` to the request body so
 * handlers receive them as ordinary params, matching the `authMW` convention.
 */
export default () => async (req: any, _res: any, next: any) => {
    const languageCode = req.body?.languageCode || req.header("language") || "en-US";
    try {
        const token = req.header(VISITOR_TOKEN_HEADER);
        if (!token) {
            throw apiValidationException("no_token", "token", null, languageCode);
        }

        const context = await resolveVisitorSession({token, languageCode});
        req.body.visitorUser = context.visitorUser;
        req.body.visitorChannel = context.visitorChannel;
        req.body.visitorCompany = context.visitorCompany;
        req.body.actionInitializer = `visitor: ${context.visitorUser._id.toString()}`;
        req.body.logger?.updateActionInitializer(req.body.actionInitializer);

        return next();
    }
    catch (e) {
        return next(e);
    }
};
