/**
 * Server Logging System
 * 
 * Hierarchical logging system built on Winston with daily log rotation.
 * Provides structured logging with action tracking, indentation, and multiple log levels.
 * 
 * Features:
 * - Hierarchical logger creation with parent-child relationships
 * - Automatic indentation for nested operations
 * - Action counting for request/operation tracking
 * - Multiple log levels: info, warn, err, debug, default
 * - Daily log rotation with compression
 * - Console and file output
 * - Service code filtering (dontPrintCodes)
 * 
 * Log Format:
 * - Timestamp (ISO format)
 * - Log level (padded to 7 chars)
 * - Action number (12-digit zero-padded)
 * - Action initializer (server name)
 * - Indentation (preSpace)
 * - Message
 * - Updated rows count (if applicable)
 * 
 * Log Rotation:
 * - Daily rotation: logs/application/YYYY-MM-DD.log
 * - Automatic compression: .gz files
 * - Max file size: 20MB
 * - Max files retained: 2 days
 * 
 * @module loggers/serverLog
 */

const {createLogger, transports, format} = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');

/** Global action counter for request/operation tracking */
let ActionCount: number = 0;

/**
 * Gets and increments the global action counter
 * 
 * @returns Next action number (incremented)
 */
function getActionCount(): number {
    return ++ActionCount;
}

const WinstonLogger = createLogger({
    level: 'info',
    format: format.combine(
        format.timestamp(),
        format.simple()
    ),
    transports: [
        new transports.Console(),
        new DailyRotateFile({
            filename: 'logs/application/%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            zippedArchive: true,
            maxSize: '20m',
            maxFiles: '2d'
        })
    ]
});

/** Array of service codes to exclude from logging (for filtering) */
const dontPrintCodes = [];

/** Log message type levels */
type logMessageType = "warn" | "err" | "info" | "debug" | "default";

/** Debug level (1-5, currently unused but reserved for future filtering) */
type logDebugLevel = "1" | "2" | "3" | "4" | "5";

/**
 * Log entry type definition
 */
type logType = {
    message: any,
    type: logMessageType,
    actionInitializer?: string,
    actionNumber: number,
    serviceCode: string,
    updatedRows?: number,
    debugLevel: logDebugLevel
    preSpace: string
}

/**
 * Core logging function
 * 
 * Formats and outputs log messages to both console and Winston logger.
 * Filters out messages for service codes in dontPrintCodes array.
 * 
 * @param args - Log entry parameters
 * @returns Formatted log message string
 */
function log(args: logType): string {

    if (!!args.serviceCode && dontPrintCodes.includes(args.serviceCode)) {
        return;
    }
    const timeNow = (new Date()).toISOString();
    let actionNumber = ("000000000000000" + args.actionNumber).slice(-15);
    let messageType = args.type.toUpperCase().padEnd(7, '_');
    let updatedRows = args.updatedRows ? `[updated entries: ${args.updatedRows}]` : "";
    let message = `[${timeNow}][${messageType}][${actionNumber}][${args.actionInitializer}]: ${args.preSpace}${args.message} ${updatedRows}`;
    let consoleMessage = `[${messageType}][${actionNumber}][${args.actionInitializer}]: ${args.preSpace}${args.message} ${updatedRows}`;

    if (args.type == "err") {
        console.error(consoleMessage);
        // WinstonLogger.error(message);
    }
    else if (args.type == "warn") {
        console.warn(consoleMessage);
        // WinstonLogger.warn(message);
    }
    else if (args.type == "info") {
        console.info(consoleMessage);
        // WinstonLogger.info(message);
    }
    else if (args.type == "debug") {
        console.info(consoleMessage);
        // WinstonLogger.info(message);
    }
    else {
        console.log(consoleMessage);
        // WinstonLogger.log(message);
    }
    return message;
}

/**
 * Logs the start of an operation
 * 
 * @param server - Server name identifier
 * @param debugLevel - Debug level (1-5)
 * @param apiCode - Service/API code identifier
 * @param action - Action number
 * @param actionInitializer - Action initializer (server name)
 * @param preSpace - Indentation prefix
 * @returns Formatted log message
 */
function start( server: string, debugLevel: logDebugLevel, apiCode: string, action: number, actionInitializer: string, preSpace: string ): string {
    return log({
        message: `==== ${server} [${apiCode}] starting ====`,
        type: "info",
        actionInitializer,
        actionNumber: action,
        serviceCode: apiCode,
        debugLevel: debugLevel,
        preSpace
    });
}
/**
 * Logs an update message during an operation
 * 
 * @param server - Server name identifier
 * @param debugLevel - Debug level (1-5)
 * @param apiCode - Service/API code identifier
 * @param action - Action number
 * @param actionInitializer - Action initializer (server name)
 * @param preSpace - Indentation prefix
 * @param message - Log message content
 * @param type - Log message type (default: "info")
 */
function update( server: string, debugLevel: logDebugLevel, apiCode: string, action: number, actionInitializer: string, preSpace: string, message: string, type: logMessageType = "info") {
    log({
        message: message,
        type,
        actionInitializer,
        actionNumber: action,
        serviceCode: apiCode,
        debugLevel: debugLevel,
        preSpace
    });
}
/**
 * Logs operation failure with error details
 * 
 * @param totalTime - Total operation time in milliseconds
 * @param server - Server name identifier
 * @param debugLevel - Debug level (1-5)
 * @param apiCode - Service/API code identifier
 * @param action - Action number
 * @param actionInitializer - Action initializer (server name)
 * @param preSpace - Indentation prefix
 * @param error - Error object or message
 */
function fail(totalTime: number, server: string, debugLevel: logDebugLevel, apiCode: string, action: number, actionInitializer: string, preSpace: string, error: any) {
    log({
        message: JSON.stringify(error) !== "{}" ? JSON.stringify(error) : error.toString(),
        type: "err",
        actionNumber: action,
        actionInitializer,
        serviceCode: apiCode,
        debugLevel: debugLevel,
        preSpace
    });
    log({
        message: `==== ${server} [${apiCode}] failed in [${totalTime}] ms ====`,
        type: "err",
        actionNumber: action,
        actionInitializer,
        serviceCode: apiCode,
        debugLevel: debugLevel,
        preSpace
    });
}
/**
 * Logs operation completion with timing and updated rows count
 * 
 * @param totalTime - Total operation time in milliseconds
 * @param server - Server name identifier
 * @param debugLevel - Debug level (1-5)
 * @param apiCode - Service/API code identifier
 * @param action - Action number
 * @param actionInitializer - Action initializer (server name)
 * @param preSpace - Indentation prefix
 * @param updatedRows - Number of database rows updated (optional)
 * @returns Formatted log message
 */
function finish(totalTime: number, server: string, debugLevel: logDebugLevel, apiCode: string, action: number, actionInitializer: string, preSpace: string, updatedRows: number): string {
    return log({
        message: `==== ${server} [${apiCode}] finished in [${totalTime}] ms ====`,
        type: "info",
        actionNumber: action,
        actionInitializer,
        serviceCode: apiCode,
        updatedRows,
        debugLevel: debugLevel,
        preSpace
    });
}

/**
 * Server logger interface
 * 
 * Provides methods for hierarchical logging with automatic indentation and action tracking.
 */
export type serverLogger = {
    /** Start an operation (increases indentation) */
    start: Function,
    /** Log a warning message */
    warn: Function,
    /** Log an error message */
    err: Function,
    /** Log an info message */
    info: Function,
    /** Log a debug message */
    debug: Function,
    /** Log a default message */
    log: Function,
    /** Log operation failure (decreases indentation) */
    fail: Function,
    /** Finish an operation with timing (decreases indentation) */
    finish: Function,
    /** Current action number */
    action: number,
    /** Current action number in string format */
    actionNumber: string,
    /** Create a new logger instance with the same apiCode */
    renew: Function,
    /** Update indentation level */
    updateSpace: Function,
    /** Update action initializer name */
    updateActionInitializer: Function,
    /** Update server name */
    updateServer: Function,
    /** Service/API code identifier */
    apiCode: string,
    /** Get current indentation prefix */
    getPreSpace: Function
}

/**
 * Creates a hierarchical logger instance
 * 
 * Creates a new logger with optional parent logger for hierarchical logging.
 * Child loggers inherit action number and indentation from parent.
 * 
 * @param apiCode - Service/API code identifier (e.g., "user_service", "auth_middleware")
 * @param parentLogger - Optional parent logger instance for hierarchical logging
 * @returns Logger instance with logging methods
 * 
 * @example
 * ```typescript
 * // Create root logger
 * const rootLogger = getLogger("api_server");
 * rootLogger.start("Initializing server");
 * 
 * // Create child logger
 * const dbLogger = getLogger("database", rootLogger);
 * dbLogger.start("Connecting to MongoDB");
 * dbLogger.info("Connection established");
 * dbLogger.finish("Connected successfully");
 * 
 * rootLogger.finish("Server initialized");
 * ```
 */
export function getLogger(apiCode: string, parentLogger?: any): serverLogger {

    const space = "    ";
    let startEpoch = Date.now();
    let debugLevel: logDebugLevel = "1";
    let action = !!parentLogger ? parentLogger.action : getActionCount();
    let preSpace = !!parentLogger ? (parentLogger.getPreSpace() + space) : "";
    let actionInitializer = global.ServerName;
    let server = global.ServerName;
    let actionNumber = ("000000000000000" + action).slice(-15);

    function spaceUpdater(howMany: number = 1){
        if( howMany > 0 ){
            preSpace = preSpace + (space.repeat(howMany));
        }
        else{
            if( Math.abs(howMany) * space.length <= preSpace.length ){
                preSpace = preSpace.replace( space.repeat(Math.abs(howMany)), "" );
            }
            else{
                preSpace = "";
            }
        }
    }

    return {
        start: (startMessage?: string): string               => {
            let message = start(server, debugLevel, apiCode, action, actionInitializer, preSpace );
            spaceUpdater();
            if( !!startMessage ){
                update(server, debugLevel, apiCode, action, actionInitializer, preSpace, startMessage, "info");
                spaceUpdater();
            }
            return message;
        },
        warn: (message: string)         => update(server, debugLevel, apiCode, action, actionInitializer, preSpace, message, "warn"      ),
        err: (message: string)          => update(server, debugLevel, apiCode, action, actionInitializer, preSpace, message, "err"       ),
        info: (message: string)         => update(server, debugLevel, apiCode, action, actionInitializer, preSpace, message, "info"      ),
        debug: (message: string)        => update(server, debugLevel, apiCode, action, actionInitializer, preSpace, message, "debug"     ),
        log: (message: string)          => update(server, debugLevel, apiCode, action, actionInitializer, preSpace, message, "default"   ),
        fail: (error: any)        => {
            spaceUpdater(-1);
            const totalTime = Date.now() - startEpoch;
            fail(totalTime, server, debugLevel, apiCode, action, actionInitializer, preSpace, error);
        },
        finish: (finishMessage?: string, updatedRows?: number)  => {
            if( !!finishMessage ){
                spaceUpdater(-1);
                update(server, debugLevel, apiCode, action, actionInitializer, preSpace, finishMessage, "info");
            }
            spaceUpdater(-1);
            const totalTime = Date.now() - startEpoch;
            return finish(totalTime, server, debugLevel, apiCode, action, actionInitializer, preSpace, updatedRows);
        },
        action,
        actionNumber,
        renew: (): serverLogger => { return getLogger(apiCode); },
        updateSpace: (howMany: number = 1) => spaceUpdater(howMany),
        updateActionInitializer: (newActionInitializer: string) => {
            actionInitializer = newActionInitializer;
        },
        updateServer: (newServer: string) => {
            server = newServer;
        },
        apiCode,
        getPreSpace: (): string => {return preSpace}
    };
}