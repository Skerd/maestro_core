/**
 * The platform's ban on a person's account (D191), decided on its report desk: a banned account opens no company at
 * all (`account_banned` at sign-in and on every request), and its open sessions end at once. The platform's own staff
 * are never banned this way: their access is their roles.
 *
 * @module domain/reports/accountBan
 */

import type {ClientSession} from "mongoose";
import {ObjectId} from "mongodb";
import {userService} from "@coreModule/database/schemas/user/user.service";
import {userSessionService} from "@coreModule/database/schemas/userSession/userSession.service";
import {notifySessionRevoked} from "@coreModule/database/schemas/userSession/userSession.actions";
import {findPlatformCompanyId} from "@coreModule/utilities/security/platformAccess";
import {asCrossTenant} from "@coreModule/utilities/endpoints/tenantScope";
import {runAfterCommit} from "@coreModule/utilities/middlewares/transactionUtils";
import type {serverLogger} from "@coreModule/loggers/serverLog";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";

export type AccountBanContext = {
    decidedBy: string;
    reason?: string;
    session?: ClientSession;
    logger: serverLogger;
    languageCode: string;
};

/** Bans an account, ending every session it has in any company, or lifts the ban. */
export async function setAccountBanned(userId: ObjectId, banned: boolean, ctx: AccountBanContext): Promise<void> {
    const {session, logger, languageCode} = ctx;
    const user = await userService.findById(userId, {session, languageCode});
    if (!user) throw apiValidationException("not_found", "", null, languageCode);
    if (banned) {
        const platformId = await findPlatformCompanyId();
        if (user._id.equals(ctx.decidedBy) || user.isBot || (platformId && await user.hasAtLeastOneRole(platformId))) {
            throw apiValidationException("account_ban_not_allowed", "", null, languageCode);
        }
    }
    await userService.updateById(user._id, banned
        ? {$set: {bannedAt: new Date(), bannedBy: new ObjectId(ctx.decidedBy), ...(ctx.reason?.trim() ? {bannedReason: ctx.reason.trim()} : {})}}
        : {$unset: {bannedAt: 1, bannedBy: 1, bannedReason: 1}},
    {session, logger, languageCode, auditUserId: ctx.decidedBy});
    if (!banned) {
        logger.info(`Account ${user._id.toString()} no longer banned`);
        return;
    }
    // Every company's sessions of this person: the ban is the platform's, not one company's.
    const open = await asCrossTenant("a platform ban ends the account's sessions in every company (D191)", async () => {
        const sessions = await userSessionService.find({user: user._id, isActive: true}, {session, logger, languageCode}, undefined, "_id");
        if (sessions.length > 0) {
            await userSessionService.updateMany({_id: {$in: sessions.map((row) => row._id)}}, {$set: {isActive: false}}, {session, logger, languageCode});
        }
        return sessions;
    });
    await runAfterCommit(session, async () => {
        for (const row of open) notifySessionRevoked(user._id.toString(), row._id.toString(), logger);
    });
    logger.info(`Account ${user._id.toString()} banned; ${open.length} session(s) ended`);
}
