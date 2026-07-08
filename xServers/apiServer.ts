/**
 * API Server Entry Point
 * 
 * Main Express.js server initialization and configuration for the Arpeggio-Maestro API.
 * 
 * This server provides:
 * - RESTful API endpoints with automatic route discovery
 * - CORS configuration with configurable allowed origins
 * - Request body parsing with size limits
 * - Request IP extraction middleware
 * - Request ID generation for tracing
 * - Metrics collection middleware
 * - Request timeout validation
 * - Error handling middleware
 * - Connection to external services (MongoDB, Redis, Kafka, WebSocket, Telegram)
 * 
 * Server Lifecycle:
 * 1. Validates environment configuration
 * 2. Sets up CORS, body parser, and request middleware
 * 3. Starts listening on configured port
 * 4. Connects to MongoDB, Redis, Kafka, WebSocket, and Telegram
 * 5. Registers all API routes automatically
 * 6. Sets up error handling
 * 
 * @module apiServer
 */

import mongoose from "mongoose";
import requestIp from 'request-ip';
import bodyParser from "body-parser";
import {CONSTANTS, SERVER} from "@coreModule/environment";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {createRouteRegistry} from "@coreModule/utilities/endpoints/routeRegistry";
import {connectToKafka} from "@coreModule/connections/connectToKafka";
import {connectToRedis} from "@coreModule/connections/connectToRedis";
import express, {Application, NextFunction, Response} from 'express';
import {connectToMongoDb} from "@coreModule/connections/connectToMongoDb";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {connectToTelegramInstance} from "@coreModule/connections/connectToTelegram";
import {connectToWebSocketServer} from "@coreModule/connections/connectToWebSocketServer";
import {
    hydrateAllServiceCounters,
    startServiceCountersFlush
} from "@coreModule/utilities/serviceMetrics/serviceCounters";
import {registerAllNotificationHandlers} from "@coreModule/domain/notifications/registerAllNotificationHandlers";
import {loadAllCronHandlers} from "@coreModule/cronjobs/bootstrap/loadAllHandlers";
import {randomUUID} from "crypto";
import {requestTimeout, requestValidator} from "@coreModule/utilities/middlewares/requestValidator";
import {metricsMiddleware} from "@coreModule/utilities/middlewares/metricsMW";
import {validateConfiguration} from "@coreModule/environment/validator";
import {ServerError} from "armonia/src/modules/core/types";
import path from "path";
import fs from "fs";
import {isModuleEnabled} from "@coreModule/utilities/modules/enabledModules";
import {createRolePermissions} from "@coreModule/database/schemas/rolePermission/rolePermission.default";

/** Express application instance */
const application: Application = express();
mongoose.set('strictQuery', true);

/** Global server name identifier for logging and service identification */
global.ServerName = `EndPointServer{${SERVER.NODE_SIGNATURE}}`;

// ============================================================================
// Server Configuration Functions
// ============================================================================

/**
 * Configures CORS (Cross-Origin Resource Sharing) settings for the Express application
 * 
 * Sets up CORS middleware with:
 * - Configurable allowed origins (from SERVER.ALLOWED_ORIGINS or '*' for all)
 * - Support for credentials (cookies, authorization headers)
 * - Allowed HTTP methods (GET, POST, PUT, DELETE, PATCH, OPTIONS)
 * - Custom headers (Content-Type, Authorization, x-auth-token, x-company-id, x-device-id, language, source)
 * - Exposed response headers (rate limit headers, request ID)
 * 
 * @param parentLogger - Optional parent logger instance for hierarchical logging
 */
function updateServerCorsSettings(parentLogger?: serverLogger){
    let logger = getLogger("serverCorsSettingsUpdater", parentLogger);
    logger.start("Setting up application cors...");
    
    const allowedOrigins = SERVER.ALLOWED_ORIGINS ? SERVER.ALLOWED_ORIGINS.split(',').map(origin => origin.trim()) : ['*'];
    
    // application.use(cors({
    //     origin: (origin, callback) => {
    //         // Allow requests with no origin (mobile apps, Postman, etc.)
    //         if (!origin) {
    //             return callback(null, true);
    //         }
    //         // Allow all origins if configured
    //         if (allowedOrigins.includes('*')) {
    //             return callback(null, true);
    //         }
    //         // Check if origin is allowed
    //         if (allowedOrigins.includes(origin)) {
    //             return callback(null, true);
    //         }
    //         callback(new Error('Not allowed by CORS'));
    //     },
    //     credentials: true,
    //     methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    //     allowedHeaders: ['Content-Type', 'Authorization', 'x-auth-token', 'x-company-id', 'x-device-id', 'language', 'source'],
    //     exposedHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset', 'X-Request-ID']
    // }));
    
    logger.finish("Finished setting up application cors!");
}
/**
 * Configures request IP extraction middleware
 * 
 * Extracts client IP address from request headers (X-Forwarded-For, X-Real-IP, etc.)
 * and makes it available via request.clientIp. Useful for rate limiting, logging, and security.
 * 
 * @param parentLogger - Optional parent logger instance for hierarchical logging
 */
function updateServerRequestIpMiddleware(parentLogger?: serverLogger){
    let logger = getLogger("serverRequestIpMiddlewareUpdater", parentLogger);
    logger.start("Setting up request ip middleware...");
    application.use(requestIp.mw());
    logger.finish("Finished setting up request ip middleware!");
}
/**
 * Configures application accessibility checker middleware
 * 
 * Currently a placeholder for future service availability checks.
 * Can be extended to check database connectivity, external service status, etc.
 * 
 * @param parentLogger - Optional parent logger instance for hierarchical logging
 */
function updateServerAccessibilityMiddleware(parentLogger?: serverLogger){
    let logger = getLogger("serverAccessibilitySettingsUpdater", parentLogger);
    logger.start("Setting up application accessibility checker...");
    application.use((_, res: Response, next: NextFunction) => {
        // if (!isAppActive) {
        //     return res.status(503).json({ message: "Service temporarily unavailable" });
        // }
        next();
    });
    logger.finish("Finished setting up application accessibility checker!");
}
/**
 * Configures body parser middleware for JSON and URL-encoded requests
 * 
 * Sets up body parsing with:
 * - Configurable size limit (default: 10mb, from SERVER_BODY_LIMIT env var)
 * - Request size validation to prevent oversized payloads
 * - JSON parsing for application/json content type
 * - URL-encoded parsing with extended option enabled
 * 
 * Throws apiValidationException if request body exceeds configured limit.
 * 
 * @param parentLogger - Optional parent logger instance for hierarchical logging
 */
function updateServerBodyParserSettings(parentLogger?: serverLogger){
    let logger = getLogger("serverBodyParserSettingsUpdater", parentLogger);
    logger.start("Setting up application body parser...");
    
    const bodyLimit = process.env.SERVER_BODY_LIMIT || "10mb";
    application.use(bodyParser.json({
        limit: bodyLimit,
        // Validate request size
        verify: (req: any, res: Response, buf: Buffer) => {
            let maxSize = 10 * 1024 * 1024; // Default 10MB

            const units: { [key: string]: number } = {
                'kb': 1024,
                'mb': 1024 * 1024,
                'gb': 1024 * 1024 * 1024
            };

            const match = bodyLimit.toLowerCase().match(/^(\d+)(kb|mb|gb)?$/);
            if (match) {
                const value = parseInt(match[1], 10);
                const unit = match[2] || 'mb';
                maxSize = value * (units[unit] || units['mb']);
            }

            if (buf.length > maxSize) {
                throw apiValidationException(
                    "request_too_large",
                    null,
                    null,
                    req.body?.languageCode || CONSTANTS.DEFAULT_LANGUAGE,
                    [bodyLimit, `${(buf.length / 1024 / 1024).toFixed(2)}mb`],
                );
            }
        }
    }));
    application.use(bodyParser.urlencoded({extended: true, limit: bodyLimit}));
    
    logger.debug(`Body parser limit set to: ${bodyLimit}`);
    logger.finish("Finished setting up application body parser!");
}
/**
 * Updates server configuration including timezone settings
 * 
 * Sets process timezone to SERVER.TIMEZONE for consistent date/time handling.
 * Logs physical server time before and after timezone configuration.
 * 
 * @param parentLogger - Optional parent logger instance for hierarchical logging
 */
function updateServerConfiguration(parentLogger?: serverLogger){
    let logger = getLogger("serverConfigurationUpdater", parentLogger);
    let now = new Date();
    logger.start("Updating server configuration...");

    logger.debug(`Physical server is at: ${now.toString()}`);
    process.env.TZ = SERVER.TIMEZONE;
    // process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    now = new Date();
    logger.debug(`Server is set to: ${now.toString()}`);

    logger.finish("Finished updating server configuration!");
}
/**
 * Sets up header validation middleware for API endpoints
 * 
 * Validates required headers:
 * - x-device-id: Device identifier (optional for media endpoints)
 * - User-Agent: Browser/client user agent (optional for media endpoints)
 * 
 * Currently validation is commented out but can be enabled for stricter enforcement.
 * Media endpoints are exempt from header validation.
 * 
 * @param application - Express application instance
 * @param parentLogger - Parent logger instance for hierarchical logging
 */
function setupEndpointsHeaderValidationHandling(application: Application, parentLogger: serverLogger){
    const logger = getLogger("setting_up_endpoint_error_handling", parentLogger);
    logger.start(`Setting up endpoint header validation handling...`);
    application.use((req, res, next) => {
        try{
            const deviceId = req.header('x-device-id');
            const userAgent = req.header('User-Agent');
            if( !req.header("language") ){
                req.headers["language"] = CONSTANTS.DEFAULT_LANGUAGE;
            }
            const languageCode = req.header("language");
            const isMedia = req.originalUrl.includes("/media");
            if( !deviceId && !isMedia){
                throw apiValidationException("api_header_value_missing", null, null, languageCode, ["x-device-id"]);
            }
            if( !userAgent && !isMedia ){
                throw apiValidationException("api_header_value_missing", null, null, languageCode, ["User-Agent"]);
            }
            next();
        }catch(error: any){
            return next(error);
        }
    });
    logger.finish(`Finished setting up endpoint header validation handling!`);
}
/**
 * Sets up global error handling middleware for Express application
 * 
 * Catches all errors thrown in route handlers and middleware, formats them
 * using the error handler utility, and returns consistent error responses.
 * 
 * Error response format:
 * - status: HTTP status code
 * - error: Error message
 * - errorCode: Application-specific error code
 * - extraMessage: Additional error details (optional)
 * - content: Error content/data (optional)
 * 
 * @param application - Express application instance
 * @param parentLogger - Parent logger instance for hierarchical logging
 */
function setupEndpointsErrorHandling(application: Application, parentLogger: serverLogger){
    const logger = getLogger("setting_up_endpoint_error_handling", parentLogger);
    logger.start(`Setting up endpoint error handling...`);

    application.use((error: ServerError | Error, req: any, res: any, next: any) => {
        if( error instanceof ServerError){
            return res.status(error.status).json(error);
        }
        else{
            if( process.env.NODE_ENV === "development" ){
                return res.status(500).json({
                    stack: error.stack,
                    message: error.message
                });
            }
            logger.err("Internal server error, cannot notify user about server problems!");
            return res.status(500).json({
                error: "Internal server error",
                errorCode: "internal_error"
            });
        }
    });
    logger.finish(`Finished setting up endpoint error handling!`);
}
/**
 * Sets up request ID middleware for request tracing
 * 
 * Generates or extracts request ID from x-request-id header and:
 * - Adds request ID to request headers
 * - Sets X-Request-ID response header
 * - Adds requestId to request body for use in handlers
 * 
 * Request IDs enable distributed tracing and request correlation across services.
 * 
 * @param application - Express application instance
 * @param parentLogger - Parent logger instance for hierarchical logging
 */
function setupRequestIdMiddleware(application: Application, parentLogger: serverLogger){
    const logger = getLogger("setting_up_request_id_middleware", parentLogger);
    logger.start(`Setting up request ID middleware...`);

    application.use((req, res, next) => {
        const requestId = req.headers['x-request-id'] as string || randomUUID();
        req.headers['x-request-id'] = requestId;
        res.setHeader('X-Request-ID', requestId);

        // Add request ID to body for use in handlers
        if (!req.body) {
            req.body = {};
        }
        req.body.requestId = requestId;

        next();
    });

    logger.finish(`Finished setting up request ID middleware!`);
}
/**
 * Sets up metrics collection middleware
 * 
 * Collects Prometheus metrics for:
 * - HTTP request duration
 * - HTTP request count by method, route, and status code
 * - Active requests gauge
 * 
 * Metrics are exposed at /metrics endpoint for Prometheus scraping.
 * 
 * @param application - Express application instance
 * @param parentLogger - Parent logger instance for hierarchical logging
 */
function setupMetricsMiddleware(application: Application, parentLogger: serverLogger){
    const logger = getLogger("setting_up_metrics_middleware", parentLogger);
    logger.start(`Setting up metrics middleware...`);
    application.use(metricsMiddleware());
    logger.finish(`Finished setting up metrics middleware!`);
}
/**
 * Sets up request validation middleware
 *
 * Applies request body validation to prevent big payloads that lead to server overload.
 * Applies request timeout validation to prevent long-running requests
 * from consuming server resources indefinitely.
 *
 * @param application - Express application instance
 * @param parentLogger - Parent logger instance for hierarchical logging
 */
function setupRequestValidationMiddleware(application: Application, parentLogger: serverLogger){
    const logger = getLogger("setting_up_request_validation_middleware", parentLogger);
    logger.start(`Setting up request validation middleware...`);

    application.use(requestValidator());
    application.use(requestTimeout());

    logger.finish(`Finished setting up request validation middleware!`);
}

async function registerEndpoints(application: Application, parentLogger: serverLogger){
    const logger = getLogger("registering_endpoints", parentLogger);
    logger.start("Registering endpoints...");

    const modulesPath = path.resolve(__dirname, '../modules');
    if (!fs.existsSync(modulesPath)) {
        logger.err(`Modules directory does not exist: ${modulesPath}`);
        logger.finish("Finished registering all available endpoints!");
        return;
    }

    const moduleEntries = fs.readdirSync(modulesPath, { withFileTypes: true });
    const moduleDirs = moduleEntries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.'));
    logger.debug(`Found ${moduleDirs.length} module folder${moduleDirs.length !== 1 ? "s" : ""} under modules.`);

    for (const moduleEntry of moduleDirs) {
        if (!isModuleEnabled(moduleEntry.name)) {
            logger.debug(`Skipping module [${moduleEntry.name}] — not in ENABLED_MODULES.`);
            continue;
        }
        const apiBasePath = path.join(modulesPath, moduleEntry.name, 'api');
        let apiStat: fs.Stats | undefined;
        try {
            apiStat = fs.statSync(apiBasePath);
        } catch {
            apiStat = undefined;
        }
        if (!apiStat?.isDirectory()) {
            logger.debug(`Skipping module [${moduleEntry.name}] — no api directory.`);
            continue;
        }

        logger.updateSpace(1);
        logger.debug(`Registering api endpoints for [${moduleEntry.name}/api]...`);
        const apiRegistry = await createRouteRegistry(logger, apiBasePath);
        apiRegistry.applyRoutes(application);
        logger.debug(`Finished registering ${apiRegistry.getRouteCount()} api endpoints!`);
        logger.updateSpace(-1);
    }

    logger.finish("Finished registering all available endpoints!");
}

// =========================================================

let logger = getLogger("serverInitialization");
logger.start("Setting up api server");

logger.debug("Validating environment configuration...");
try {
    validateConfiguration();
    logger.debug("Environment configuration validation passed!");
}
catch (error: any) {
    logger.fail(`Environment configuration validation failed: ${error.message}`);
    process.exit(1);
}

logger.debug("Updating server cors settings...");
updateServerCorsSettings(logger);
logger.debug("Finished updating server cors settings!");

logger.debug("Updating server request ip middleware...");
updateServerRequestIpMiddleware(logger);
logger.debug("Finished updating server request ip middleware!");

logger.debug("Updating server accessibility middleware...");
updateServerAccessibilityMiddleware(logger);
logger.debug("Finished updating server accessibility middleware!");

logger.debug("Updating server body parser settings...");
updateServerBodyParserSettings(logger);
logger.debug("Finished updating server body parser settings!");

logger.debug("Setting up request validation middleware...");
setupRequestValidationMiddleware(application, logger);
logger.debug("Finished setting up request validation middleware!");

logger.debug("Updating server configuration...");
updateServerConfiguration(logger);
logger.debug("Finished updating server configuration!");

logger.debug(`Opening server port to listen to: [${SERVER.PORT}]`);

// ============================================================================
// Server Initialization
// ============================================================================

/**
 * Starts the Express server and initializes all connections
 * 
 * Server startup sequence:
 * 1. Validates environment configuration
 * 2. Configures CORS, body parser, and middleware
 * 3. Starts listening on SERVER.PORT
 * 4. Connects to MongoDB (with retry logic)
 * 5. Connects to Redis (with retry logic)
 * 6. Connects to Kafka (with retry logic)
 * 7. Connects to WebSocket server (with retry logic)
 * 8. Starts Telegram bot service
 * 9. Sets up request ID and metrics middleware
 * 10. Sets up header validation
 * 11. Discovers and registers all API routes
 * 12. Sets up error handling middleware
 * 
 * All connections use retry logic and will retry until successful or process exits.
 */
application.listen(SERVER.PORT, async () => {

    logger.debug(`Server started on port: [${SERVER.PORT}]`);

    logger.debug(`Connecting to mongoDB instance, retrying until completed...`);
    await connectToMongoDb(logger, true);
    logger.debug(`Connected to mongoDB instance!`);

    // logger.debug(`Starting redis connection supervisor...`);
    // await connectToRedis(logger);
    // logger.debug(`Redis connection supervisor started!`);

    // logger.debug(`Hydrating service counters from Redis...`);
    // await hydrateAllServiceCounters();
    // startServiceCountersFlush();
    // logger.debug(`Service counters hydrated and flush loop started.`);
    //
    // logger.debug(`Starting Kafka connection supervisor...`);
    // await connectToKafka(logger);
    // logger.debug(`Kafka connection supervisor started!`);

    logger.debug(`Starting websocket connection supervisor...`);
    await connectToWebSocketServer(logger);
    logger.debug(`Websocket connection supervisor started!`);

    // logger.debug("Starting telegraf connection supervisor...");
    // await connectToTelegramInstance(logger);
    // logger.debug("Finished starting telegraf connection supervisor!")

    logger.debug("Registering all notification handlers...");
    await registerAllNotificationHandlers(logger);
    logger.debug("Finished registering all notification handlers!");

    // logger.debug("Loading cron handler registry (execution runs in cronServer)...");
    // await loadAllCronHandlers(logger);
    // logger.debug("Cron handler registry loaded.");

    logger.debug("Setting up request ID middleware...");
    setupRequestIdMiddleware(application, logger);
    logger.debug(`Finished setting up request ID middleware!`);

    logger.debug("Setting up metrics middleware...");
    setupMetricsMiddleware(application, logger);
    logger.debug(`Finished setting up metrics middleware!`);

    logger.debug("Setting up endpoints header validation handling...");
    setupEndpointsHeaderValidationHandling(application, logger);
    logger.debug(`Finished setting up endpoints header validation handling!`);

    logger.debug("Registering all available endpoints...");
    await registerEndpoints(application, logger);
    logger.debug("Finished registering all available endpoints!");

    logger.debug("Syncing schema-derived role permissions for all registered models...");
    await createRolePermissions(logger);
    logger.debug("Finished syncing schema-derived role permissions!");

    logger.debug('Setting up server endpoint error handling...');
    setupEndpointsErrorHandling(application, logger);
    logger.debug(`Finished setting up server endpoint error handling!`);

    logger.finish(`Done setting up api server!`);

});
