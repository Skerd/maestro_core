/**
 * Circuit Breaker Pattern Implementation
 * 
 * Provides circuit breaker functionality for external dependencies (MongoDB, Redis, Kafka).
 * Prevents cascading failures by opening the circuit when failures exceed threshold.
 * 
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Circuit is open, requests fail fast
 * - HALF_OPEN: Testing if service recovered, allows limited requests
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
    /** Failure threshold before opening circuit (default: 5) */
    failureThreshold?: number;
    /** Time window in milliseconds for counting failures (default: 60000 = 1 minute) */
    timeout?: number;
    /** Time in milliseconds to wait before attempting half-open (default: 30000 = 30 seconds) */
    resetTimeout?: number;
    /** Success threshold in half-open state before closing (default: 2) */
    successThreshold?: number;
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
    private lastFailureTime?: number;
    private lastSuccessTime?: number;
    private totalRequests: number = 0;
    private totalFailures: number = 0;
    private totalSuccesses: number = 0;
    private config: Required<CircuitBreakerConfig>;
    private logger: serverLogger;

    constructor(config: CircuitBreakerConfig = {}) {
        this.config = {
            failureThreshold: config.failureThreshold || 5,
            timeout: config.timeout || 60000,
            resetTimeout: config.resetTimeout || 30000,
            successThreshold: config.successThreshold || 2,
            logger: config.logger || getLogger('circuit_breaker'),
            name: config.name || 'CircuitBreaker'
        };
        this.logger = this.config.logger;
    }

    /**
     * Execute a function with circuit breaker protection
     * 
     * @param fn - Function to execute
     * @returns Result of the function
     * @throws Error if circuit is open or function fails
     */
    async execute<T>(fn: () => Promise<T>): Promise<T> {
        this.totalRequests++;

        // Check if circuit should transition from OPEN to HALF_OPEN
        if (this.state === CircuitState.OPEN) {
            const timeSinceLastFailure = this.lastFailureTime 
                ? Date.now() - this.lastFailureTime 
                : Infinity;
            
            if (timeSinceLastFailure >= this.config.resetTimeout) {
                this.logger.info?.(
                    `Circuit breaker ${this.config.name} transitioning from OPEN to HALF_OPEN`,
                    { name: this.config.name, state: this.state }
                );
                this.state = CircuitState.HALF_OPEN;
                this.successes = 0;
            } else {
                // Circuit is still open, fail fast
                this.logger.warn?.(
                    `Circuit breaker ${this.config.name} is OPEN, failing fast`,
                    { name: this.config.name, state: this.state }
                );
                throw new Error(`Circuit breaker ${this.config.name} is OPEN`);
            }
        }

        try {
            const result = await fn();
            this.onSuccess();
            return result;
        } catch (error) {
            this.onFailure();
            throw error;
        }
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
            }
        } else if (this.state === CircuitState.CLOSED) {
            // Reset failure count on success (within timeout window)
            const timeSinceLastFailure = this.lastFailureTime 
                ? Date.now() - this.lastFailureTime 
                : Infinity;
            
            if (timeSinceLastFailure > this.config.timeout) {
                this.failures = 0;
            }
        }
    }

    /**
     * Handle failed operation
     */
    private onFailure(): void {
        this.totalFailures++;
        this.lastFailureTime = Date.now();

        if (this.state === CircuitState.HALF_OPEN) {
            // Any failure in half-open state opens the circuit
            this.logger.warn?.(
                `Circuit breaker ${this.config.name} transitioning from HALF_OPEN to OPEN`,
                { name: this.config.name, state: this.state }
            );
            this.state = CircuitState.OPEN;
            this.successes = 0;
        } else if (this.state === CircuitState.CLOSED) {
            this.failures++;
            
            // Check if we should open the circuit
            const timeSinceLastFailure = this.lastFailureTime 
                ? Date.now() - this.lastFailureTime 
                : 0;
            
            // Reset failure count if outside timeout window
            if (timeSinceLastFailure > this.config.timeout) {
                this.failures = 1;
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
     * Get current state
     */
    getState(): CircuitState {
        return this.state;
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
        this.lastFailureTime = undefined;
        this.lastSuccessTime = undefined;
    }

    /**
     * Check if circuit is open (will fail fast)
     */
    isOpen(): boolean {
        // Check if we should transition from OPEN to HALF_OPEN
        if (this.state === CircuitState.OPEN) {
            const timeSinceLastFailure = this.lastFailureTime 
                ? Date.now() - this.lastFailureTime 
                : Infinity;
            
            if (timeSinceLastFailure >= this.config.resetTimeout) {
                this.state = CircuitState.HALF_OPEN;
                this.successes = 0;
                return false;
            }
            return true;
        }
        
        return false;
    }
}

/**
 * Create a circuit breaker instance
 * 
 * @param config - Circuit breaker configuration
 * @returns Circuit breaker instance
 */
export function createCircuitBreaker(config: CircuitBreakerConfig = {}): CircuitBreaker {
    return new CircuitBreaker(config);
}

/**
 * Pre-configured circuit breakers for common services
 */
export const mongoDbCircuitBreaker = createCircuitBreaker({
    name: 'MongoDB',
    failureThreshold: 5,
    timeout: 60000,
    resetTimeout: 30000,
    successThreshold: 2
});

export const redisCircuitBreaker = createCircuitBreaker({
    name: 'Redis',
    failureThreshold: 5,
    timeout: 60000,
    resetTimeout: 30000,
    successThreshold: 2
});

export const kafkaCircuitBreaker = createCircuitBreaker({
    name: 'Kafka',
    failureThreshold: 5,
    timeout: 60000,
    resetTimeout: 30000,
    successThreshold: 2
});

export const webSocketCircuitBreaker = createCircuitBreaker({
    name: 'WebSocket',
    failureThreshold: 5,
    timeout: 60000,
    resetTimeout: 30000,
    successThreshold: 2
});

export const telegramCircuitBreaker = createCircuitBreaker({
    name: 'Telegram',
    failureThreshold: 5,
    timeout: 60000,
    resetTimeout: 30000,
    successThreshold: 2
});
