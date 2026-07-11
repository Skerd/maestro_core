/**
 * AI-assistant channel helper.
 *
 * Single choke point that guarantees EXACTLY ONE 1-1 channel between a
 * company-role user and that company's AI bot user. Every flow that grants a
 * user an active role in a company (signup, invite, add-existing-user, company
 * creation, backfill) funnels through {@link ensureAiChannel}, and the frontend
 * can also call it lazily on first open. Uniqueness is additionally enforced at
 * the database level by the partial unique index on {company, aiOwnerUser}.
 */

import {ClientSession, ObjectId} from "mongodb";
import {UpdateQuery} from "mongoose";
import {serverLogger} from "@coreModule/loggers/serverLog";
import {IChannel} from "@coreModule/database/schemas/channel/channel";
import {channelService} from "@coreModule/database/schemas/channel/channel.service";
import User from "@coreModule/database/schemas/user/user";

export interface AiChannelParams {
    /** The human user the AI channel belongs to. */
    userId: ObjectId;
    /** The company the channel is scoped to (each company has its own bot). */
    companyId: ObjectId;
    session?: ClientSession | null;
    logger?: serverLogger;
    languageCode?: string;
    auditUserId?: string | ObjectId;
}

/** Locates the company's AI bot user, if one exists. */
export async function findCompanyBotId(companyId: ObjectId, session?: ClientSession | null): Promise<ObjectId | null> {
    const q = User.findOne({isBot: true, companies: companyId}).select("_id");
    const bot = session ? await q.session(session) : await q;
    return bot?._id ?? null;
}

/**
 * Returns the AI-assistant channel between `userId` and the company bot,
 * creating it if missing and repairing membership if the user had been removed.
 *
 * Idempotent. Returns `null` when no channel should exist — the target user is a
 * bot (no bot<->bot channels), the user does not exist, or the company has no
 * bot yet.
 *
 * Concurrency: the unique index makes a duplicate impossible; a losing racer
 * catches the duplicate-key error and returns the winner's channel. Note that
 * inside an active transaction a duplicate-key error aborts the transaction, so
 * the race-recovery path is only reached on non-transactional (e.g. lazy) calls.
 */
export async function ensureAiChannel(params: AiChannelParams): Promise<IChannel | null> {
    const {userId, companyId, session, logger, languageCode, auditUserId} = params;

    // 1. Never create an AI channel for a bot user (avoids a bot talking to itself).
    const userQuery = User.findOne({_id: userId, isBot: {$ne: true}}).select("_id");
    const humanUser = session ? await userQuery.session(session) : await userQuery;
    if (!humanUser) {
        logger?.debug(`ensureAiChannel: user ${userId.toString()} is a bot or missing - skipping`);
        return null;
    }

    // 2. Resolve the company bot.
    const botId = await findCompanyBotId(companyId, session);
    if (!botId) {
        logger?.debug(`ensureAiChannel: company ${companyId.toString()} has no bot user yet - skipping`);
        return null;
    }

    const findExisting = (): Promise<IChannel | null> => channelService.findOne(
        {company: companyId, isAiAssistant: true, aiOwnerUser: userId},
        {session: session ?? undefined, logger, languageCode}
    );

    // 3. Fast path: already exists. Repair membership if the user had been
    //    removed (e.g. hidden after losing all roles, then re-added).
    const existing = await findExisting();
    if (existing) {
        const hasUser = (existing.users || []).some((u) => u.toString() === userId.toString());
        if (!hasUser) {
            logger?.debug(`ensureAiChannel: re-adding user ${userId.toString()} to existing AI channel ${existing._id.toString()}`);
            await channelService.updateById(
                existing._id,
                {
                    $addToSet: {users: userId},
                    $pull: {leftUsers: {user: userId}}
                } as unknown as UpdateQuery<IChannel>,
                {session: session ?? undefined, logger, languageCode, auditUserId}
            );
            return await findExisting();
        }
        return existing;
    }

    // 4. Create. Tolerate the unique-index race on non-transactional calls.
    try {
        return await channelService.create(
            {
                users: [userId, botId],
                owner: userId,
                company: companyId,
                name: "",
                isGroup: false,
                isAiAssistant: true,
                aiOwnerUser: userId,
                adminUsers: []
            } as unknown as Partial<IChannel>,
            {session: session ?? undefined, logger, languageCode, auditUserId}
        );
    } catch (e) {
        const code = (e as {code?: number})?.code;
        if (code === 11000 || code === 11001) {
            logger?.debug(`ensureAiChannel: lost creation race for user ${userId.toString()} - returning existing`);
            return await findExisting();
        }
        throw e;
    }
}

/**
 * Detaches the user from their AI channel so it disappears from their chat list
 * WITHOUT destroying the channel or its history. Called when a user loses all
 * active roles in / is removed from a company. Returning to the company via
 * {@link ensureAiChannel} reuses the same channel (membership is repaired).
 */
export async function hideAiChannel(params: AiChannelParams): Promise<void> {
    const {userId, companyId, session, logger, languageCode, auditUserId} = params;
    await channelService.updateOne(
        {company: companyId, isAiAssistant: true, aiOwnerUser: userId},
        {
            $pull: {users: userId, leftUsers: {user: userId}}
        } as unknown as UpdateQuery<IChannel>,
        {session: session ?? undefined, logger, languageCode, auditUserId}
    );
}
