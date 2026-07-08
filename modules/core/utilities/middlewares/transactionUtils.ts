import {ClientSession, Document, Model} from 'mongoose';
import {AuthenticatedMWType} from './authMW';

export { transactionHandler } from './transactionHandler';

export type TransactionRequired = {
    session: ClientSession;
};

/**
 * Type for handler parameters that include transaction session support
 * 
 * Use this type when defining handlers that may or may not use transactions.
 * The session will be automatically provided by transactionHandler middleware.
 */
export type TransactionEnabledParams = AuthenticatedMWType & {
    session?: ClientSession;
};

/**
 * Type for handler parameters that require transaction session
 * 
 * Use this type when defining handlers that MUST use transactions.
 * This ensures type safety that session will always be present.
 */
export type TransactionRequiredParams = AuthenticatedMWType & {
    session: ClientSession;
};

/**
 * Options for database operations that support sessions
 */
export interface SessionOptions {
    session?: ClientSession | null;
}

/**
 * Checks if a transaction session exists in the params
 * 
 * @param params - Handler parameters that may contain a session
 * @returns true if session exists, false otherwise
 * 
 * @example
 * ```typescript
 * async function handler(params: TransactionEnabledParams) {
 *     if (hasTransactionSession(params)) {
 *         // Use transaction-aware operations
 *         await model.save({ session: params.session });
 *     } else {
 *         // Use regular operations
 *         await model.save();
 *     }
 * }
 * ```
 */
export function hasTransactionSession(params: TransactionEnabledParams): params is TransactionRequiredParams {
    return params.session !== undefined && params.session !== null;
}

/**
 * Ensures a session exists, throwing an error if it doesn't
 * 
 * Useful for handlers that require transactions but want clear error messages.
 * 
 * @param params - Handler parameters that should contain a session
 * @param errorMessage - Optional custom error message
 * @throws Error if session doesn't exist
 * 
 * @example
 * ```typescript
 * async function criticalHandler(params: TransactionEnabledParams) {
 *     ensureTransactionSession(params, "This operation requires a transaction");
 *     // Now TypeScript knows params.session exists
 *     await model1.save({ session: params.session });
 *     await model2.save({ session: params.session });
 * }
 * ```
 */
export function ensureTransactionSession(
    params: TransactionEnabledParams,
    errorMessage: string = "Transaction session is required for this operation"
): asserts params is TransactionRequiredParams {
    if (!hasTransactionSession(params)) {
        throw new Error(errorMessage);
    }
}

/**
 * Creates session options object for Mongoose operations
 * 
 * Helper function to safely create options object with session.
 * Returns empty object if no session exists, or { session } if it does.
 * 
 * @param params - Handler parameters that may contain a session
 * @returns Options object with session if available, empty object otherwise
 * 
 * @example
 * ```typescript
 * async function handler(params: TransactionEnabledParams) {
 *     const options = getSessionOptions(params);
 *     await Model.findById(id, null, options);
 *     await Model.updateOne({ _id }, { $set: data }, options);
 * }
 * ```
 */
export function getSessionOptions(params: TransactionEnabledParams): SessionOptions {
    return params.session ? { session: params.session } : {};
}

/**
 * Executes a database operation with session if available
 * 
 * Wrapper function that automatically applies session to operations.
 * 
 * @param operation - A function that performs a database operation
 * @param params - Handler parameters that may contain a session
 * @returns The result of the operation
 * 
 * @example
 * ```typescript
 * async function handler(params: TransactionEnabledParams) {
 *     const result = await withSession(async (session) => {
 *         return await Model.findById(id).session(session);
 *     }, params);
 * }
 * ```
 */
export async function withSession<T>(
    operation: (session: ClientSession) => Promise<T>,
    params: TransactionEnabledParams
): Promise<T> {
    if (hasTransactionSession(params)) {
        return await operation(params.session);
    }
    // If no session, create a temporary one or throw error
    // For now, we'll require session for this helper
    throw new Error("Transaction session is required for withSession helper");
}

/**
 * Executes a database operation with session if available, otherwise without
 * 
 * Similar to withSession but gracefully handles missing sessions.
 * 
 * @param withSessionOp - Operation to run with session
 * @param withoutSessionOp - Operation to run without session
 * @param params - Handler parameters that may contain a session
 * @returns The result of the appropriate operation
 * 
 * @example
 * ```typescript
 * async function handler(params: TransactionEnabledParams) {
 *     const result = await withSessionOrWithout(
 *         async (session) => await Model.findById(id).session(session),
 *         async () => await Model.findById(id),
 *         params
 *     );
 * }
 * ```
 */
export async function withSessionOrWithout<T>(
    withSessionOp: (session: ClientSession) => Promise<T>,
    withoutSessionOp: () => Promise<T>,
    params: TransactionEnabledParams
): Promise<T> {
    if (hasTransactionSession(params)) {
        return await withSessionOp(params.session);
    }
    return await withoutSessionOp();
}

/**
 * Helper to apply session to Mongoose model operations
 * 
 * Returns a session-aware version of common Mongoose operations.
 * 
 * @param model - Mongoose model instance
 * @param params - Handler parameters that may contain a session
 * @returns Object with session-aware methods
 * 
 * @example
 * ```typescript
 * async function handler(params: TransactionEnabledParams) {
 *     const ops = getSessionAwareOperations(Company, params);
 *     const company = await ops.findById(id);
 *     await ops.updateOne({ _id }, { $set: data });
 * }
 * ```
 */
export function getSessionAwareOperations<T extends Document>(
    model: Model<T>,
    params: TransactionEnabledParams
) {
    const options = getSessionOptions(params);
    
    return {
        findById: (id: any) => model.findById(id).session(options.session || undefined),
        findOne: (conditions: any) => model.findOne(conditions).session(options.session || undefined),
        find: (conditions: any) => model.find(conditions).session(options.session || undefined),
        create: (docs: any) => model.create(docs, options),
        updateOne: (conditions: any, update: any) => 
            model.updateOne(conditions, update, options),
        updateMany: (conditions: any, update: any) => 
            model.updateMany(conditions, update, options),
        deleteOne: (conditions: any) => 
            model.deleteOne(conditions, options),
        deleteMany: (conditions: any) => 
            model.deleteMany(conditions, options),
        insertMany: (docs: any[]) => 
            model.insertMany(docs, options),
    };
}

/**
 * Validates that a transaction session is active
 * 
 * Throws an error if session exists but transaction is not active.
 * Useful for debugging transaction state issues.
 * 
 * @param params - Handler parameters that may contain a session
 * @param errorMessage - Optional custom error message
 * @throws Error if session exists but transaction is not active
 * 
 * @example
 * ```typescript
 * async function handler(params: TransactionRequiredParams) {
 *     validateTransactionActive(params);
 *     // Proceed with transaction operations
 * }
 * ```
 */
export function validateTransactionActive(
    params: TransactionEnabledParams,
    errorMessage: string = "Transaction session exists but transaction is not active"
): void {
    if (params.session && !params.session.inTransaction()) {
        throw new Error(errorMessage);
    }
}

/**
 * Gets transaction state information for debugging
 * 
 * Returns information about the current transaction state.
 * Useful for logging and debugging.
 * 
 * @param params - Handler parameters that may contain a session
 * @returns Object with transaction state information
 * 
 * @example
 * ```typescript
 * async function handler(params: TransactionEnabledParams) {
 *     const state = getTransactionState(params);
 *     logger.debug(`Transaction state: ${JSON.stringify(state)}`);
 * }
 * ```
 */
export function getTransactionState(params: TransactionEnabledParams): {
    hasSession: boolean;
    isActive: boolean;
    sessionId?: string;
} {
    if (!params.session) {
        return {
            hasSession: false,
            isActive: false
        };
    }

    return {
        hasSession: true,
        isActive: params.session.inTransaction(),
        sessionId: params.session.id?.toString()
    };
}

