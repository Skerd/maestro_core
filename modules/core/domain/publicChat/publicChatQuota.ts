/**
 * Public chat quotas — the layer the per-endpoint IP rate limiter cannot cover.
 *
 * `rateLimiter` keys on the request IP, which is the right defence against a
 * single noisy client but the wrong one for the two failure modes that actually
 * cost money here:
 *
 *   1. One visitor holding a conversation open all day. Their IP limit resets
 *      every minute; their *token* should not. Hence the per-visitor hour/day
 *      budget.
 *   2. A distributed flood across many IPs against one tenant, which would
 *      exhaust the shared model server for every other tenant. Hence the
 *      per-company daily reply ceiling.
 *
 * Both are Redis counters with a TTL. If Redis is unavailable the quota check
 * FAILS OPEN — mirroring `rateLimiter`, which also skips when Redis is down.
 * Losing Redis should degrade abuse protection, not take the public site's chat
 * offline.
 *
 * @module publicChat/publicChatQuota
 */

import {getRedisClient, isRedisConnected} from "@coreModule/connections/connectToRedis";
import type {serverLogger} from "@coreModule/loggers/serverLog";
import {PUBLIC_CHAT} from "@coreModule/environment";

const HOUR_SECONDS = 60 * 60;
const DAY_SECONDS = 24 * 60 * 60;

export type QuotaScope = "visitor_hour" | "visitor_day" | "company_day";

export interface QuotaVerdict {
    allowed: boolean;
    /** Which budget ran out, when `allowed` is false. */
    scope?: QuotaScope;
}

/**
 * Increment a counter and report whether it is still within budget.
 * Returns `true` (allowed) on any Redis problem — see the fail-open note above.
 */
async function consume(key: string, limit: number, ttlSeconds: number, logger?: serverLogger): Promise<boolean> {
    if (!isRedisConnected()) {
        return true;
    }
    try {
        const redis = getRedisClient();
        const count = await redis.incr(key);
        if (count === 1) {
            await redis.expire(key, ttlSeconds);
        }
        return count <= limit;
    }
    catch (e: any) {
        logger?.warn(`Public chat quota check failed for ${key}: ${e?.message ?? e}`);
        return true;
    }
}

/** Current UTC day/hour stamps, so counters roll over on a fixed boundary. */
function stamps(): {hour: string; day: string} {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    return {day, hour: `${day}:${now.getUTCHours()}`};
}

/**
 * Charge a visitor message against every applicable budget.
 *
 * Called AFTER cheap validation but BEFORE the message is persisted or handed to
 * the model, so a rejected message costs nothing downstream.
 */
export async function consumeVisitorMessageQuota(params: {
    visitorId: string;
    companyId: string;
    logger?: serverLogger;
}): Promise<QuotaVerdict> {
    const {visitorId, companyId, logger} = params;
    const {hour, day} = stamps();

    const withinHour = await consume(
        `publicChat:visitor:${visitorId}:h:${hour}`,
        PUBLIC_CHAT.MAX_MESSAGES_PER_HOUR,
        HOUR_SECONDS,
        logger,
    );
    if (!withinHour) {
        return {allowed: false, scope: "visitor_hour"};
    }

    const withinDay = await consume(
        `publicChat:visitor:${visitorId}:d:${day}`,
        PUBLIC_CHAT.MAX_MESSAGES_PER_DAY,
        DAY_SECONDS,
        logger,
    );
    if (!withinDay) {
        return {allowed: false, scope: "visitor_day"};
    }

    const withinCompany = await consume(
        `publicChat:company:${companyId}:d:${day}`,
        PUBLIC_CHAT.MAX_COMPANY_REPLIES_PER_DAY,
        DAY_SECONDS,
        logger,
    );
    if (!withinCompany) {
        return {allowed: false, scope: "company_day"};
    }

    return {allowed: true};
}
