/**
 * Request Validation Middleware
 * 
 * Validates request size, array sizes, and nested object depths to prevent DoS attacks.
 */

import {NextFunction, Request, Response} from 'express';
import {apiValidationException} from 'armonia/src/modules/core/helpers/exceptions';
import {CONSTANTS, REQUEST_VALIDATION} from '@coreModule/environment';

/**
 * Configuration for request validation
 */
export interface RequestValidationConfig {
    /** Maximum array size (default: 1000) */
    maxArraySize?: number;
    /** Maximum nested object depth (default: 10) */
    maxDepth?: number;
    /** Maximum string length (default: 100000) */
    maxStringLength?: number;
}

const DEFAULT_CONFIG: Required<RequestValidationConfig> = {
    maxArraySize: REQUEST_VALIDATION.MAX_ARRAY_SIZE,
    maxDepth: REQUEST_VALIDATION.MAX_DEPTH,
    maxStringLength: REQUEST_VALIDATION.MAX_STRING_LENGTH
};

/**
 * Validate object depth recursively
 */
function validateDepth(obj: any, depth: number, maxDepth: number, path: string = ''): void {
    if (depth > maxDepth) {
        throw new Error(`Object depth exceeds maximum of ${maxDepth} at path: ${path}`);
    }

    if (obj === null || obj === undefined || typeof obj !== 'object') {
        return;
    }

    if (Array.isArray(obj)) {
        if (obj.length > DEFAULT_CONFIG.maxArraySize) {
            throw new Error(`Array size ${obj.length} exceeds maximum of ${DEFAULT_CONFIG.maxArraySize} at path: ${path}`);
        }
        obj.forEach((item, index) => {
            validateDepth(item, depth + 1, maxDepth, `${path}[${index}]`);
        });
    } else {
        for (const key in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, key)) {
                const value = obj[key];
                if (typeof value === 'string' && value.length > DEFAULT_CONFIG.maxStringLength) {
                    throw new Error(`String length ${value.length} exceeds maximum of ${DEFAULT_CONFIG.maxStringLength} at path: ${path}.${key}`);
                }
                validateDepth(value, depth + 1, maxDepth, path ? `${path}.${key}` : key);
            }
        }
    }
}

/**
 * Request validation middleware
 * 
 * Validates:
 * - Array sizes
 * - Nested object depths
 * - String lengths
 * 
 * @param config - Validation configuration
 * @returns Express middleware function
 */
export function requestValidator(config: RequestValidationConfig = {}) {
    const finalConfig = { ...DEFAULT_CONFIG, ...config };

    return (req: Request, res: Response, next: NextFunction) => {
        try {
            // Validate request body
            if (req.body && typeof req.body === 'object') {
                validateDepth(req.body, 0, finalConfig.maxDepth);
            }

            // Validate query parameters
            if (req.query && typeof req.query === 'object') {
                validateDepth(req.query, 0, finalConfig.maxDepth);
            }

            next();
        } catch (error: any) {
            const languageCode = (req.body as any)?.languageCode || CONSTANTS.DEFAULT_LANGUAGE;
            throw apiValidationException(
                "request_validation_failed",
                error.message || null,
                null,
                languageCode
            );
        }
    };
}

/**
 * Request timeout middleware
 * 
 * Sets a timeout for request processing to prevent hanging requests.
 * 
 * @param timeoutMs - Timeout in milliseconds (default: 30000 = 30 seconds)
 * @returns Express middleware function
 */
export function requestTimeout(timeoutMs: number = parseInt(process.env.REQUEST_TIMEOUT_MS || '480000', 10)) {
    return (req: Request, res: Response, next: NextFunction) => {
        const timeout = setTimeout(() => {
            if (!res.headersSent) {
                const languageCode = (req.body as any)?.languageCode || CONSTANTS.DEFAULT_LANGUAGE;
                res.status(408).json({
                    error: apiValidationException(
                        "request_timeout",
                        null,
                        null,
                        languageCode,
                        [`${timeoutMs}ms`]
                    )
                });
            }
        }, timeoutMs);

        // Clear timeout when response is sent
        res.on('finish', () => {
            clearTimeout(timeout);
        });

        next();
    };
}

