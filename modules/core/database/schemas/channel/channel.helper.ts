/**
 * Channel helpers — internal AI-assistant threads and public visitor chats.
 *
 * Internal: {@link ensureAiChannel} guarantees exactly one 1-1 channel between a
 * company-role user and that company's AI bot. Signup, invite, add-user, company
 * creation, and backfill all funnel through it; uniqueness is also enforced by
 * the partial unique index on {company, aiOwnerUser}.
 *
 * Public: creates the (visitor user + channel) pair that backs one website
 * conversation. The channel is created with BOTH `isPublicChat: true` and
 * `isAiAssistant: true` so the existing assistant responder picks it up. Bot
 * identity comes from {@link ICompany.getRobotId} / `Company.findRobotId`.
 */

import {randomBytes} from "crypto";
import {ObjectId} from "mongodb";
import {ClientSession, UpdateQuery} from "mongoose";
import {serverLogger} from "@coreModule/loggers/serverLog";
import User, {IUser} from "@coreModule/database/schemas/user/user";
import Message from "@coreModule/database/schemas/message/message";
import Channel, {IChannel, PublicChatStatus} from "@coreModule/database/schemas/channel/channel";
import {channelService} from "@coreModule/database/schemas/channel/channel.service";
import Company from "@coreModule/database/schemas/company/company";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";

/** Domain used for generated visitor usernames. Never receives mail. */
const VISITOR_USERNAME_DOMAIN = "visitors.local";

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

/**
 * Returns the AI-assistant channel between `userId` and the company bot,
 * creating it if missing and repairing membership if the user had been removed.
 *
 * Idempotent. Returns a null channel when none should exist — the target user
 * is a bot, the user does not exist, or the company has no bot yet.
 *
 * Concurrency: the unique index makes a duplicate impossible; a losing racer
 * catches the duplicate-key error and returns the winner's channel. Note that
 * inside an active transaction a duplicate-key error aborts the transaction, so
 * the race-recovery path is only reached on non-transactional (e.g. lazy) calls.
 */
export async function ensureAiChannel(params: AiChannelParams): Promise<{aiChannel: IChannel | null, alreadyExist: boolean}> {
    const {userId, companyId, session, logger, languageCode, auditUserId} = params;

    const userQuery = User.findOne({_id: userId, isBot: {$ne: true}}).select("_id");
    const humanUser = session ? await userQuery.session(session) : await userQuery;
    if (!humanUser) {
        logger?.debug(`ensureAiChannel: user ${userId.toString()} is a bot or missing - skipping`);
        return {aiChannel: null, alreadyExist: false};
    }

    const botId = await Company.findRobotId(companyId, session);
    if (!botId) {
        logger?.debug(`ensureAiChannel: company ${companyId.toString()} has no bot user yet - skipping`);
        return {aiChannel: null, alreadyExist: false};
    }

    const findExisting = (): Promise<IChannel | null> => channelService.findOne(
        {company: companyId, isAiAssistant: true, aiOwnerUser: userId},
        {session: session ?? undefined, logger, languageCode}
    );

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
            return {
                aiChannel: await findExisting(),
                alreadyExist: true,
            };
        }
        return {
            aiChannel: existing,
            alreadyExist: true,
        };
    }

    try {
        return {
            aiChannel: await channelService.create(
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
            ),
            alreadyExist: false,
        };
    } catch (e) {
        const code = (e as {code?: number})?.code;
        if (code === 11000 || code === 11001) {
            logger?.debug(`ensureAiChannel: lost creation race for user ${userId.toString()} - returning existing`);
            return {
                aiChannel: await findExisting(),
                alreadyExist: false,
            };
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

export interface CreatePublicChatParams {
    companyId: ObjectId;
    languageCode: string;
    logger?: serverLogger;
    session?: ClientSession | null;
    visitor?: {
        ip?: string;
        userAgent?: string;
        entryUrl?: string;
        referrer?: string;
    };
    context?: {
        project?: ObjectId;
        unit?: ObjectId;
    };
}

/**
 * Create a fresh anonymous visitor user.
 *
 * Deliberately role-less: `roles` stays empty forever, which is what keeps the
 * visitor out of `authMW("private")`, the panel user pickers, company member
 * counts, and the internal AI-channel backfill. Never grant a visitor a role.
 */
export async function createVisitorUser(params: {
    companyId: ObjectId;
    languageCode: string;
    logger?: serverLogger;
    session?: ClientSession | null;
}): Promise<IUser> {
    const {companyId, session} = params;

    const handle = randomBytes(12).toString("hex");
    const shortId = handle.slice(0, 6).toUpperCase();

    const [visitor] = await User.create(
        [{
            username: `visitor.${handle}@${VISITOR_USERNAME_DOMAIN}`,
            name: "Visitor",
            surname: shortId,
            fullName: `Visitor ${shortId}`,
            password: randomBytes(32).toString("hex"),
            isVisitor: true,
            isActive: true,
            companies: [companyId],
            roles: [],
        } as any],
        session ? {session} : {},
    );

    return visitor;
}

/**
 * Create a new public chat: a visitor user plus their channel with the company bot.
 *
 * @throws when the company has no bot user (nothing could answer the visitor).
 */
export async function createPublicChat(params: CreatePublicChatParams): Promise<{ channel: IChannel; visitor: IUser; }> {
    const {companyId, languageCode, logger, session, visitor: visitorMeta, context} = params;

    const botId = await Company.findRobotId(companyId, session);
    if (!botId) {
        logger?.err(`Company ${companyId.toString()} has no bot user; cannot open a public chat`);
        throw apiValidationException("ai_channel_unavailable", "company", null, languageCode);
    }

    const visitor = await createVisitorUser({companyId, languageCode, logger, session});

    const channel = await channelService.create(
        {
            users: [visitor._id, botId],
            owner: visitor._id,
            company: companyId,
            name: "",
            isGroup: false,
            isAiAssistant: true,
            aiOwnerUser: visitor._id,
            isPublicChat: true,
            publicChat: {
                status: "bot" as PublicChatStatus,
                visitor: {
                    ip: visitorMeta?.ip,
                    userAgent: visitorMeta?.userAgent,
                    entryUrl: visitorMeta?.entryUrl,
                    referrer: visitorMeta?.referrer,
                },
                ...(context?.project || context?.unit ? {context} : {}),
                lastVisitorActivity: new Date(),
            },
            adminUsers: [],
        } as unknown as Partial<IChannel>,
        {session: session ?? undefined, logger, languageCode, auditUserId: visitor._id.toString()},
    );

    logger?.debug(`Opened public chat ${channel._id.toString()} for visitor ${visitor._id.toString()}`);
    return {channel, visitor};
}

/**
 * Record that the visitor did something, for idle-based retention sweeps.
 *
 * MUST use an explicit `$set`. `updateById` with an `auditUserId` and no
 * operator takes an `Object.assign(doc, update)` path, which treats
 * `"publicChat.lastVisitorActivity"` as a literal property name rather than a
 * dotted path — mongoose then discards it and the write silently does nothing.
 */
export async function touchPublicChat(params: {
    channelId: ObjectId;
    languageCode?: string;
    logger?: serverLogger;
    auditUserId?: string;
}): Promise<void> {
    const {channelId, languageCode, logger, auditUserId} = params;
    const now = new Date();
    await channelService.updateById(
        channelId,
        {
            $set: {
                lastAction: now,
                "publicChat.lastVisitorActivity": now,
            },
        } as unknown as UpdateQuery<IChannel>,
        {logger, languageCode, auditUserId},
    );
}

/** Move a public chat to a new lifecycle state. */
export async function setPublicChatStatus(params: {
    channelId: ObjectId;
    status: PublicChatStatus;
    languageCode?: string;
    logger?: serverLogger;
    auditUserId?: string;
}): Promise<void> {
    const {channelId, status, languageCode, logger, auditUserId} = params;

    // Explicit `$set` is REQUIRED — see the note on touchPublicChat. Without an
    // operator, `updateById` + `auditUserId` assigns the dotted string as a
    // literal property and the status change is silently lost.
    const update: Record<string, unknown> = {"publicChat.status": status};
    if (status === "requested_human") {
        update["publicChat.handoffRequestedAt"] = new Date();
    }
    if (status === "closed") {
        update["publicChat.closedAt"] = new Date();
    }
    // Leaving human ownership: drop the assignee. `$unset` with `""` is
    // stripped by mongoose on ObjectId paths, so this must be an explicit null.
    if (status === "bot" || status === "closed") {
        update["publicChat.assignedTo"] = null;
    }

    await channelService.updateById(
        channelId,
        {$set: update} as unknown as UpdateQuery<IChannel>,
        {logger, languageCode, auditUserId},
    );
}

/**
 * Whether the assistant should answer the next visitor message.
 * Only the `bot` state is bot-served; every other state means a human owns it.
 */
export function isBotServing(channel: IChannel): boolean {
    return (channel.publicChat?.status ?? "bot") === "bot";
}

/**
 * Destroy a public conversation and the anonymous identity behind it.
 *
 * This is the right-to-erasure path, so it is a genuine hard delete rather than
 * a soft one — a soft-deleted transcript is still a retained transcript. Any
 * CRM lead the visitor created is deliberately NOT touched: they gave those
 * details to be contacted, that record has its own lifecycle and its own
 * erasure path, and silently destroying a salesperson's pipeline entry from an
 * anonymous endpoint would be the wrong call.
 */
export async function erasePublicChat(params: {
    channelId: ObjectId;
    visitorId: ObjectId;
    languageCode?: string;
    logger?: serverLogger;
}): Promise<void> {
    const {channelId, visitorId, logger} = params;

    await Message.deleteMany({channel: channelId});
    await Channel.deleteOne({_id: channelId, isPublicChat: true});
    // `isVisitor` guard: never delete a real user, even if `aiOwnerUser` was
    // somehow pointing at one.
    await User.deleteOne({_id: visitorId, isVisitor: true});

    logger?.debug(`Erased public chat ${channelId.toString()} and visitor ${visitorId.toString()}`);
}
