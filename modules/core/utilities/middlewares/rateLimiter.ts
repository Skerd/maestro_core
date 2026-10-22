/**
 * Rate Limiting Middleware
 *
 * Redis-backed fixed window. The increment and its expiry run as one atomic
 * script (`redisIncrWithExpiry`), so the window is set once and never lost.
 *
 * Redis down, failing, or its circuit breaker open:
 * - Public auth (`failClosed: true`) rejects the request — better to block signup
 *   / password reset than to run unbounded.
 * - Private CRUD (`failClosed` omitted / false) is fail-open so an outage of Redis
 *   does not take the panel down. List `limit` is capped separately.
 */

import {NextFunction, Request, Response} from 'express';
import {executeWithCircuitBreaker, getRedisClient, redisIncrWithExpiry} from '@coreModule/connections/connectToRedis';
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {CONSTANTS} from "@coreModule/environment";

export interface RateLimitOptions {
    windowMs: number;
    max: number;
    skipSuccessfulRequests?: boolean;
    skipFailedRequests?: boolean;
    /** When Redis is unavailable, reject instead of skipping the limit. */
    failClosed?: boolean;
}

function getRateLimitNameFromRequest(req: Request): string {
    const fullPath = req.method + "[" + req.baseUrl + (req.path === "/" ? "" : req.path) + "]";
    return fullPath
        .replace(/^\//, "")
        .replace(/\/+/g, ":")
        .trim() || "root";
}

export function rateLimiter(options: RateLimitOptions) {
    const {
        windowMs,
        max,
        skipSuccessfulRequests = false,
        skipFailedRequests = false,
        failClosed = false,
    } = options;

    return async (req: Request, res: Response, next: NextFunction) => {
        const languageCode = req.header("language") || CONSTANTS.DEFAULT_LANGUAGE;

        try {
            const limitName = getRateLimitNameFromRequest(req);

            const userId = req.body?.userInfo?._id?.toString();
            const ip = req.body?.requestIp || req.ip || req.socket.remoteAddress || 'unknown';
            const redisKey = userId ? `rate_limit:${limitName}:user:${userId}` : `rate_limit:${limitName}:ip:${ip}`;
            const windowSeconds = Math.ceil(windowMs / 1000);

            const counter = await redisIncrWithExpiry(redisKey, windowSeconds);
            if (!counter) {
                if (failClosed) {
                    return next(apiValidationException("rate_limit_exceeded", null, null, languageCode));
                }
                return next();
            }
            const {count, ttlSeconds: expiresInSeconds} = counter;

            if (count > max) {
                throw apiValidationException(
                    "rate_limit_exceeded",
                    null,
                    null,
                    languageCode,
                    [],
                    expiresInSeconds
                );
            }

            res.setHeader('X-RateLimit-Limit', max.toString());
            res.setHeader('X-RateLimit-Remaining', Math.max(0, max - count).toString());
            res.setHeader('X-RateLimit-Reset', new Date(Date.now() + expiresInSeconds * 1000).toISOString());

            const originalSend = res.send;
            res.send = function(body: any) {
                const statusCode = res.statusCode;
                const isSuccess = statusCode >= 200 && statusCode < 300;
                const isFailure = statusCode >= 400;

                if ((skipSuccessfulRequests && isSuccess) || (skipFailedRequests && isFailure)) {
                    executeWithCircuitBreaker(() => getRedisClient().decr(redisKey)).catch(() => {
                        // Ignore errors
                    });
                }

                return originalSend.call(this, body);
            };

            next();
        }
        catch (error) {
            next(error);
        }
    };
}
