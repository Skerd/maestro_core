/**
 * Function Timing Utility
 * 
 * Provides comprehensive timing functionality for functions, methods, and operations.
 * Integrates with the existing serverLogger system.
 */

import {performance} from 'perf_hooks';
import {serverLogger} from '@coreModule/loggers/serverLog';

/**
 * Timing result interface
 */
export interface TimingResult {
    duration: number;        // Duration in milliseconds
    durationFormatted: string; // Human-readable duration
    startTime: number;       // Start timestamp
    endTime: number;         // End timestamp
    functionName: string;    // Name of the function/operation
}

/**
 * Timing options
 */
export interface TimingOptions {
    /** Logger instance to use for logging */
    logger?: serverLogger;
    /** Log level for timing messages */
    logLevel?: 'info' | 'debug' | 'warn';
    /** Whether to log the timing result */
    logResult?: boolean;
    /** Custom message prefix */
    messagePrefix?: string;
    /** Minimum duration to log (in ms). Times below this won't be logged. */
    minDurationToLog?: number;
    /** Whether to include function arguments in log */
    logArguments?: boolean;
    /** Whether to include return value in log */
    logReturnValue?: boolean;
}

/**
 * Timer class for tracking function execution time
 */
export class FunctionTimer {
    private startTime: number;
    private functionName: string;
    private options: Required<TimingOptions>;
    private logger?: serverLogger;

    constructor(functionName: string, options: TimingOptions = {}) {
        this.functionName = functionName;
        this.startTime = performance.now();
        this.logger = options.logger;
        
        this.options = {
            logger: options.logger,
            logLevel: options.logLevel || 'debug',
            logResult: options.logResult !== false,
            messagePrefix: options.messagePrefix || '⏱️',
            minDurationToLog: options.minDurationToLog || 0,
            logArguments: options.logArguments || false,
            logReturnValue: options.logReturnValue || false,
            ...options
        };
    }

    /**
     * Stop the timer and get the result
     */
    stop(): TimingResult {
        const endTime = performance.now();
        const duration = endTime - this.startTime;
        const durationFormatted = this.formatDuration(duration);

        const result: TimingResult = {
            duration,
            durationFormatted,
            startTime: this.startTime,
            endTime,
            functionName: this.functionName
        };

        if (this.options.logResult && duration >= this.options.minDurationToLog) {
            this.logResult(result);
        }

        return result;
    }

    /**
     * Get current elapsed time without stopping
     */
    getElapsed(): number {
        return performance.now() - this.startTime;
    }

    /**
     * Log the timing result
     */
    private logResult(result: TimingResult): void {
        if (!this.logger) return;

        const message = `${this.options.messagePrefix} ${this.functionName} took ${result.durationFormatted}`;
        
        switch (this.options.logLevel) {
            case 'info':
                this.logger.info(message);
                break;
            case 'warn':
                this.logger.warn(message);
                break;
            case 'debug':
            default:
                this.logger.debug(message);
                break;
        }
    }

    /**
     * Format duration in human-readable format
     */
    private formatDuration(ms: number): string {
        if (ms < 1) {
            return `${Math.round(ms * 1000)}μs`;
        } else if (ms < 1000) {
            return `${Math.round(ms)}ms`;
        } else if (ms < 60000) {
            return `${(ms / 1000).toFixed(2)}s`;
        } else {
            const minutes = Math.floor(ms / 60000);
            const seconds = ((ms % 60000) / 1000).toFixed(2);
            return `${minutes}m ${seconds}s`;
        }
    }
}

/**
 * Time a function execution
 * 
 * @param fn - Function to time
 * @param functionName - Name of the function (for logging)
 * @param options - Timing options
 * @returns Result of the function and timing information
 * 
 * @example
 * ```typescript
 * const { result, timing } = await timeFunction(
 *     async () => await someAsyncOperation(),
 *     'someAsyncOperation',
 *     { logger }
 * );
 * ```
 */
export async function timeFunction<T>(
    fn: () => T | Promise<T>,
    functionName: string,
    options: TimingOptions = {}
): Promise<{ result: T; timing: TimingResult }> {
    const timer = new FunctionTimer(functionName, options);
    
    try {
        const result = await fn();
        const timing = timer.stop();
        return { result, timing };
    } catch (error) {
        timer.stop();
        throw error;
    }
}

/**
 * Time a synchronous function execution
 * 
 * @param fn - Function to time
 * @param functionName - Name of the function
 * @param options - Timing options
 * @returns Result of the function and timing information
 * 
 * @example
 * ```typescript
 * const { result, timing } = timeFunctionSync(
 *     () => someSyncOperation(),
 *     'someSyncOperation',
 *     { logger }
 * );
 * ```
 */
export function timeFunctionSync<T>(
    fn: () => T,
    functionName: string,
    options: TimingOptions = {}
): { result: T; timing: TimingResult } {
    const timer = new FunctionTimer(functionName, options);
    
    try {
        const result = fn();
        const timing = timer.stop();
        return { result, timing };
    } catch (error) {
        timer.stop();
        throw error;
    }
}

/**
 * Create a timer instance
 * 
 * @param functionName - Name of the function/operation
 * @param options - Timing options
 * @returns Timer instance
 * 
 * @example
 * ```typescript
 * const timer = createTimer('databaseQuery', { logger });
 * // ... do work ...
 * const timing = timer.stop();
 * ```
 */
export function createTimer(functionName: string, options: TimingOptions = {}): FunctionTimer {
    return new FunctionTimer(functionName, options);
}

/**
 * Decorator for automatic function timing
 * 
 * @param options - Timing options
 * @returns Method decorator
 * 
 * @example
 * ```typescript
 * class MyService {
 *     @Timed({ logger })
 *     async myMethod() {
 *         // This will be automatically timed
 *     }
 * }
 * ```
 */
export function Timed(options: TimingOptions = {}) {
    return function (
        target: any,
        propertyKey: string,
        descriptor: PropertyDescriptor
    ) {
        const originalMethod = descriptor.value;
        const functionName = `${target.constructor.name}.${propertyKey}`;

        descriptor.value = async function (...args: any[]) {
            const timer = new FunctionTimer(functionName, {
                ...options,
                logger: options.logger || (this as any).logger
            });

            try {
                const result = await originalMethod.apply(this, args);
                timer.stop();
                return result;
            } catch (error) {
                timer.stop();
                throw error;
            }
        };

        return descriptor;
    };
}

/**
 * Time a block of code
 * 
 * @param functionName - Name of the operation
 * @param options - Timing options
 * @returns Function that executes and times the provided function
 * 
 * @example
 * ```typescript
 * const timedOperation = timeBlock('processData', { logger });
 * const result = await timedOperation(async () => {
 *     // Your code here
 * });
 * ```
 */
export function timeBlock<T>(
    functionName: string,
    options: TimingOptions = {}
) {
    return async (fn: () => T | Promise<T>): Promise<{ result: T; timing: TimingResult }> => {
        return timeFunction(fn, functionName, options);
    };
}

