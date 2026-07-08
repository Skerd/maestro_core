/**
 * Metrics Middleware
 * 
 * Collects metrics for all API requests including:
 * - Request duration
 * - Request count by endpoint
 * - Error rates
 * - Status code distribution
 * 
 * Optimized for high-throughput with batched metric recording.
 */

import {NextFunction, Request, Response} from 'express';
import {AuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import {publishApiAccessEvent} from "@coreModule/kafka/kafkaProducer";

/**
 * Metrics middleware
 * 
 * Records request metrics for observability with batching for performance.
 * Uses Date.now() for timing (lower overhead than performance.now()) for most requests.
 * 
 * @returns Express middleware function
 */
export function metricsMiddleware() {
    return (req: Request, res: Response, next: NextFunction) => {
        // Use Date.now() for lower overhead (less precise but sufficient for metrics)
        const startTime = Date.now();
        const method = req.method;
        const endpoint = req.route?.path || req.path || 'unknown';

        // Record response when finished
        res.on('finish', () => {
            const body: AuthenticatedMWType = req.body;
            const {logger, deviceId, userAgent, requestIp, requestSource, actionUserInfo, userInfo, company} = body || {};
            const now = Date.now();
            const duration = now - startTime;
            const statusCode = res.statusCode;

            void publishApiAccessEvent({
                eventType: "api_access",
                actionNumber: logger?.actionNumber || "-",
                actionUser: actionUserInfo?._id?.toString() || undefined,
                user: userInfo?._id?.toString() || undefined,
                company: company?._id?.toString() || undefined,
                deviceId,
                duration,
                endpoint,
                errorType: statusCode >= 400 ? (statusCode >= 500 ? 'server_error' : 'client_error') : undefined,
                method,
                requestIp,
                userAgent,
                source: requestSource,
                statusCode,
                timestamp: now
            })
        });

        next();
    };
}
