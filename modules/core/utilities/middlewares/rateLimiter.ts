/**
 * Rate Limiting Middleware
 * 
 * Provides Redis-based rate limiting for different endpoint categories.
 * Critical for preventing abuse and ensuring fair resource usage.
 */

import {NextFunction, Request, Response} from 'express';
import {getRedisClient, isRedisConnected} from '@coreModule/connections/connectToRedis';
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {CONSTANTS} from "@coreModule/environment";

export interface RateLimitOptions {
    windowMs: number;                   // Time window in milliseconds
    max: number;                        // Maximum requests per window
    skipSuccessfulRequests?: boolean;   // Don't count successful requests
    skipFailedRequests?: boolean;       // Don't count failed requests
}

/**
 * Derives a rate limit key name from the request path.
 * Combines baseUrl + path and normalizes to a Redis-safe string (slashes → colons).
 */
function getRateLimitNameFromRequest(req: Request): string {
    const fullPath = req.method + "[" + req.baseUrl + (req.path === "/" ? "" : req.path) + "]";
    return fullPath
        .replace(/^\//, "")
        .replace(/\/+/g, ":")
        .trim() || "root";
}

/**
 * Create a rate limiter middleware
 * 
 * @param options - Rate limiting options
 * @returns Express middleware function
 * 
 * @example
 * ```typescript
 * const financeLimiter = createRateLimiter({
 *     windowMs: 60000,  // 1 minute
 *     max: 100,         // 100 requests per minute
 * });
 * 
 * router.post("/transfer", financeLimiter, ...);
 * ```
 */
export function rateLimiter(options: RateLimitOptions) {
    const {
        windowMs,
        max,
        skipSuccessfulRequests = false,
        skipFailedRequests = false
    } = options;

    return async (req: Request, res: Response, next: NextFunction) => {
        // Skip rate limiting if Redis is not connected
        if (!isRedisConnected()) {
            return next();
        }

        try {
            const languageCode = req.header("language") || CONSTANTS.DEFAULT_LANGUAGE;
            const limitName = getRateLimitNameFromRequest(req);

            const userId = req.body?.userInfo?._id?.toString();
            const ip = req.body?.requestIp || req.ip || req.socket.remoteAddress || 'unknown';
            const redisKey = userId ? `rate_limit:${limitName}:user:${userId}` : `rate_limit:${limitName}:ip:${ip}`;
            // Get current count
            const current = await getRedisClient().get(redisKey);
            const count = current ? parseInt(current, 10) : 0;

            let expiresInSeconds = await getRedisClient().ttl(redisKey);

            if (count >= max) {
                throw apiValidationException(
                    "rate_limit_exceeded",
                    null,
                    null,
                    languageCode,
                    [],
                    expiresInSeconds
                );
            }

            // Increment counter
            await getRedisClient().incr(redisKey);
            await getRedisClient().expire(redisKey, Math.ceil(windowMs / 1000));

            // Store rate limit info in response headers
            res.setHeader('X-RateLimit-Limit', max.toString());
            res.setHeader('X-RateLimit-Remaining', Math.max(0, max - count - 1).toString());
            res.setHeader('X-RateLimit-Reset', new Date(Date.now() + windowMs).toISOString());

            // Track response status for skip options
            const originalSend = res.send;
            res.send = function(body: any) {
                const statusCode = res.statusCode;
                const isSuccess = statusCode >= 200 && statusCode < 300;
                const isFailure = statusCode >= 400;

                // Decrement if we should skip this request
                if ((skipSuccessfulRequests && isSuccess) || (skipFailedRequests && isFailure)) {
                    getRedisClient().decr(redisKey).catch(() => {
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
