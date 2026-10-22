/**
 * Circuit Breaker Pattern Implementation
 * 
 * Provides circuit breaker functionality for external dependencies (Redis, Kafka, WebSocket, Telegram).
 * Prevents cascading failures by opening the circuit when failures exceed threshold.
 * 
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Circuit is open, requests fail fast
 * - HALF_OPEN: Testing if service recovered, lets one trial request through at a time
 */

import {getLogger, serverLogger} from '@coreModule/loggers/serverLog';

/**
 * Circuit breaker states
 */
export enum CircuitState {
    CLOSED = 'CLOSED',
    OPEN = 'OPEN',
    HALF_OPEN = 'HALF_OPEN'
}

/**
 * Circuit breaker configuration
 */
export interface CircuitBreakerConfig {
    /** Failures within one failure window that open the circuit (default: 5) */
    failureThreshold?: number;
    /** Length in milliseconds of the window failures are counted in (default: 60000 = 1 minute) */
    failureWindow?: number;
    /** Time in milliseconds to wait before attempting half-open (default: 30000 = 30 seconds) */
    resetTimeout?: number;
    /** Success threshold in half-open state before closing (default: 2) */
    successThreshold?: number;
    /**
     * Milliseconds a single call may take before it counts as a failure (default: 0 = no limit).
     * Without it a hung dependency never fails, so the circuit could never open.
     */
    callTimeout?: number;
    /** Logger instance */
    logger?: serverLogger;
    /** Name of the circuit breaker (for logging) */
    name?: string;
}

/**
 * Circuit breaker statistics
 */
export interface CircuitBreakerStats {
    state: CircuitState;
    failures: number;
    successes: number;
    lastFailureTime?: number;
    lastSuccessTime?: number;
    totalRequests: number;
    totalFailures: number;
    totalSuccesses: number;
}

/**
 * Circuit Breaker Class
 * 
 * Implements the circuit breaker pattern to prevent cascading failures.
 */
export class CircuitBreaker {
    private state: CircuitState = CircuitState.CLOSED;
    private failures: number = 0;
    private successes: number = 0;
    /** Start of the window the current `failures` are counted in. */
    private failureWindowStart?: number;
    private lastFailureTime?: number;
    private lastSuccessTime?: number;
    private totalRequests: number = 0;
    private totalFailures: number = 0;
    private totalSuccesses: number = 0;
    /** True while the single HALF_OPEN trial call is in flight. */
    private trialInFlight: boolean = false;
    private config: Required<CircuitBreakerConfig>;
    private logger: serverLogger;

    constructor(config: CircuitBreakerConfig = {}) {
        this.config = {
            failureThreshold: config.failureThreshold ?? 5,
            failureWindow: config.failureWindow ?? 60000,
            resetTimeout: config.resetTimeout ?? 30000,
            successThreshold: config.successThreshold ?? 2,
            callTimeout: config.callTimeout ?? 0,
            logger: config.logger ?? getLogger('circuit_breaker'),
            name: config.name ?? 'CircuitBreaker'
        };
        this.logger = this.config.logger;
    }

    /**
     * Execute a function with circuit breaker protection
     * 
     * @param fn - Function to execute
     * @returns Result of the function
     * @throws Error if circuit is open, the call times out or the function fails
     */
    async execute<T>(fn: () => Promise<T>): Promise<T> {
        this.totalRequests++;

        // Check if circuit should transition from OPEN to HALF_OPEN
        if (this.state === CircuitState.OPEN) {
            if (this.resetTimeoutElapsed()) {
                this.logger.info?.(
                    `Circuit breaker ${this.config.name} transitioning from OPEN to HALF_OPEN`,
                    { name: this.config.name, state: this.state }
                );
                this.state = CircuitState.HALF_OPEN;
                this.successes = 0;
            } else {
                throw this.failFast();
            }
        }

        // HALF_OPEN lets one trial call through at a time; the rest fail fast
        // instead of stampeding a dependency that is still recovering.
        const isTrial = this.state === CircuitState.HALF_OPEN;
        if (isTrial) {
            if (this.trialInFlight) {
                throw this.failFast();
            }
            this.trialInFlight = true;
        }

        try {
            const result = await this.runWithTimeout(fn);
            this.onSuccess();
            return result;
        } catch (error) {
            this.onFailure();
            throw error;
        } finally {
            if (isTrial) {
                this.trialInFlight = false;
            }
        }
    }

    private failFast(): Error {
        this.logger.debug?.(`Circuit breaker ${this.config.name} is ${this.state}, failing fast`);
        return new Error(`Circuit breaker ${this.config.name} is OPEN`);
    }

    private resetTimeoutElapsed(): boolean {
        const timeSinceLastFailure = this.lastFailureTime
            ? Date.now() - this.lastFailureTime
            : Infinity;
        return timeSinceLastFailure >= this.config.resetTimeout;
    }

    private runWithTimeout<T>(fn: () => Promise<T>): Promise<T> {
        const ms = this.config.callTimeout;
        if (ms <= 0) {
            return fn();
        }
        return new Promise<T>((resolve, reject) => {
            const pending = fn();
            const timer = setTimeout(
                () => reject(new Error(`Circuit breaker ${this.config.name} call timed out after ${ms} ms`)),
                ms
            );
            pending.then(
                (value) => { clearTimeout(timer); resolve(value); },
                (error) => { clearTimeout(timer); reject(error); }
            );
        });
    }

    /**
     * Handle successful operation
     */
    private onSuccess(): void {
        this.totalSuccesses++;
        this.lastSuccessTime = Date.now();

        if (this.state === CircuitState.HALF_OPEN) {
            this.successes++;
            if (this.successes >= this.config.successThreshold) {
                this.logger.info?.(
                    `Circuit breaker ${this.config.name} transitioning from HALF_OPEN to CLOSED`,
                    { name: this.config.name, state: this.state }
                );
                this.state = CircuitState.CLOSED;
                this.failures = 0;
                this.successes = 0;
                this.failureWindowStart = undefined;
            }
        } else if (this.state === CircuitState.CLOSED && this.failureWindowExpired(this.lastSuccessTime)) {
            this.failures = 0;
            this.failureWindowStart = undefined;
        }
    }

    /**
     * Handle failed operation
     */
    private onFailure(): void {
        const now = Date.now();
        this.totalFailures++;
        this.lastFailureTime = now;

        if (this.state === CircuitState.HALF_OPEN) {
            // Any failure in half-open state opens the circuit
            this.logger.warn?.(
                `Circuit breaker ${this.config.name} transitioning from HALF_OPEN to OPEN`,
                { name: this.config.name, state: this.state }
            );
            this.state = CircuitState.OPEN;
            this.successes = 0;
        } else if (this.state === CircuitState.CLOSED) {
            // Failures only add up within one window; an older window starts over.
            if (this.failureWindowStart === undefined || this.failureWindowExpired(now)) {
                this.failureWindowStart = now;
                this.failures = 1;
            } else {
                this.failures++;
            }

            if (this.failures >= this.config.failureThreshold) {
                this.logger.warn?.(
                    `Circuit breaker ${this.config.name} transitioning from CLOSED to OPEN`,
                    { 
                        name: this.config.name, 
                        state: this.state,
                        failures: this.failures,
                        threshold: this.config.failureThreshold
                    }
                );
                this.state = CircuitState.OPEN;
            }
        }
    }

    private failureWindowExpired(now: number): boolean {
        return this.failureWindowStart !== undefined && now - this.failureWindowStart > this.config.failureWindow;
    }

    /**
     * Get current circuit breaker statistics
     */
    getStats(): CircuitBreakerStats {
        return {
            state: this.state,
            failures: this.failures,
            successes: this.successes,
            lastFailureTime: this.lastFailureTime,
            lastSuccessTime: this.lastSuccessTime,
            totalRequests: this.totalRequests,
            totalFailures: this.totalFailures,
            totalSuccesses: this.totalSuccesses
        };
    }

    /**
     * Manually reset the circuit breaker
     */
    reset(): void {
        this.logger.info?.(
            `Circuit breaker ${this.config.name} manually reset`,
            { name: this.config.name }
        );
        this.state = CircuitState.CLOSED;
        this.failures = 0;
        this.successes = 0;
        this.failureWindowStart = undefined;
        this.lastFailureTime = undefined;
        this.lastSuccessTime = undefined;
    }

    /**
     * Check if circuit is open (calls would fail fast). Read-only: the
     * OPEN -> HALF_OPEN transition only happens inside `execute`.
     */
    isOpen(): boolean {
        return this.state === CircuitState.OPEN && !this.resetTimeoutElapsed();
    }
}

/**
 * Pre-configured circuit breakers for common services
 */
export const redisCircuitBreaker = new CircuitBreaker({
    name: 'Redis',
    failureThreshold: 5,
    failureWindow: 60000,
    resetTimeout: 30000,
    successThreshold: 2,
    callTimeout: 5000
});

export const kafkaCircuitBreaker = new CircuitBreaker({
    name: 'Kafka',
    failureThreshold: 5,
    failureWindow: 60000,
    resetTimeout: 30000,
    successThreshold: 2
    // No callTimeout: kafkajs bounds each send with its own request timeout, and
    // abandoning a send that later succeeds would duplicate the message on retry.
});

export const webSocketCircuitBreaker = new CircuitBreaker({
    name: 'WebSocket',
    failureThreshold: 5,
    failureWindow: 60000,
    resetTimeout: 30000,
    successThreshold: 2,
    callTimeout: 5000
});

export const telegramCircuitBreaker = new CircuitBreaker({
    name: 'Telegram',
    failureThreshold: 5,
    failureWindow: 60000,
    resetTimeout: 30000,
    successThreshold: 2,
    callTimeout: 15000
});
