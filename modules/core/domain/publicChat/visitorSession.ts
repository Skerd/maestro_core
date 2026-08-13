/**
 * Visitor session resolution — the shared verification path for public chat.
 *
 * Both the HTTP middleware (`visitorAuthMW`) and the WebSocket server use this,
 * so an anonymous visitor is checked identically on both transports. It lives in
 * `domain/` rather than next to the middleware precisely so the WS server does
 * not have to import an Express middleware module.
 *
 * A visitor token is long-lived (30d) and backed by no Session document, so the
 * whole chain is re-verified on every use rather than trusted from the token:
 * the token is genuinely a visitor token, the visitor user still exists and is
 * still a visitor, the channel is still a public chat, and the channel belongs
 * to the company the token names. Closed chats stay readable so the widget can
 * show the closing notice; write endpoints call {@link assertPublicChatOpen}.
 *
 * @module visitorSession
 */

import {ObjectId} from "mongodb";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {validateVisitorToken} from "@coreModule/utilities/security/visitorToken";
import {channelService} from "@coreModule/database/schemas/channel/channel.service";
import {companyService} from "@coreModule/database/schemas/company/company.service";
import {userService} from "@coreModule/database/schemas/user/user.service";
import {IChannel} from "@coreModule/database/schemas/channel/channel";
import {ICompany} from "@coreModule/database/schemas/company/company";
import {IUser} from "@coreModule/database/schemas/user/user";

export interface VisitorSession {
    visitorUser: IUser;
    visitorChannel: IChannel;
    visitorCompany: ICompany;
}

/**
 * Resolve and verify a visitor token into its visitor/channel/company triple.
 *
 *                          a token minted on one tenant's site cannot be replayed
 *                          against another tenant's.
 * @throws when any link in the chain fails.
 * @param params
 */
export async function resolveVisitorSession(params: {
    token: string;
    languageCode: string;
    originCompanyId?: ObjectId;
}): Promise<VisitorSession> {
    const {token, languageCode, originCompanyId} = params;

    const payload = validateVisitorToken(token, languageCode);
    const companyId = new ObjectId(payload.companyId);

    if (originCompanyId && !originCompanyId.equals(companyId)) {
        throw apiValidationException("visitor_token_company_mismatch", "token", null, languageCode);
    }

    const visitorUser = await userService.findOne({
        _id: new ObjectId(payload.visitorId),
        isVisitor: true,
        deletedAt: null,
    }, {languageCode});
    if (!visitorUser) {
        throw apiValidationException("visitor_session_not_found", "token", null, languageCode);
    }

    const visitorChannel = await channelService.findOne({
        _id: new ObjectId(payload.channelId),
        company: companyId,
        isPublicChat: true,
    }, {languageCode});
    if (!visitorChannel) {
        throw apiValidationException("visitor_session_not_found", "token", null, languageCode);
    }

    // The token must name the channel's OWN visitor — not merely some visitor.
    const ownerId = (visitorChannel.aiOwnerUser as any)?._id ?? visitorChannel.aiOwnerUser;
    if (!ownerId || ownerId.toString() !== visitorUser._id.toString()) {
        throw apiValidationException("visitor_session_not_found", "token", null, languageCode);
    }

    const visitorCompany = await companyService.findOne({_id: companyId, isActive: true});
    if (!visitorCompany) {
        throw apiValidationException("company_is_inactive", "company", null, languageCode);
    }

    return {visitorUser, visitorChannel, visitorCompany};
}

/**
 * Closed conversations are read-only. Call this from any endpoint that would
 * persist a visitor action (send, handoff, identify).
 */
export function assertPublicChatOpen(channel: IChannel, languageCode: string): void {
    if (channel.publicChat?.status === "closed") {
        throw apiValidationException("public_chat_is_closed", "token", null, languageCode);
    }
}

/**
 * Non-throwing variant for callers that must distinguish "not a visitor token"
 * from "invalid visitor token" — notably the WebSocket connection handler, which
 * falls through to normal user authentication when this returns null.
 */
export async function tryResolveVisitorSession(params: {
    token: string;
    languageCode: string;
    originCompanyId?: ObjectId;
}): Promise<VisitorSession | null> {
    try {
        return await resolveVisitorSession(params);
    }
    catch {
        return null;
    }
}
