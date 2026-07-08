import {NextFunction, Request, Response} from 'express';
import {ClientSession} from 'mongoose';
import {mongooseInstance} from '@coreModule/connections/connectToMongoDb';
import {getLogger, serverLogger} from '@coreModule/loggers/serverLog';

/**
 * Transaction Middleware
 * 
 * Wraps endpoints with MongoDB transaction support.
 * Automatically starts a transaction session and attaches it to req.body.
 * The asyncHandler will handle commit/abort based on success/failure.
 * 
 * Usage:
 * ```TypeScript
 * router.patch(
 *     "/endpoint",
 *     authMW("private"),
 *     transactionHandler(),
 *     asyncHandler(handlerFunction)
 * );
 * ```
 * 
 * The handler function will receive `session` in params:
 * ```TypeScript
 * async function handler(params: AuthenticatedMWType & {session: ClientSession}) {
 *     const { session } = params;
 *     await Model.save({ session });
 * }
 * ```
 * 
 * @returns Express middleware function
 */
export function transactionHandler() {
    return async (req: Request, res: Response, next: NextFunction) => {
        const logger: serverLogger = req.body?.logger || getLogger("transaction_handler");
        let session: ClientSession | null = null;

        try {
            // Start MongoDB session
            // logger.debug("Starting MongoDB transaction session...");
            session = await mongooseInstance.startSession();

            // Start transaction
            session.startTransaction();
            // logger.debug("Transaction started");

            // Attach session to request body so handlers can access it
            // This is the single source of truth for transaction sessions
            req.body.session = session;

            // Continue to next middleware
            next();

        } catch (error: any) {
            // If session creation fails, abort and clean up
            if (session && session.inTransaction()) {
                try {
                    // logger.err("Aborting transaction due to initialization error");
                    await session.abortTransaction();
                } catch (abortError) {
                    logger.err("Error aborting transaction", abortError);
                }
            }

            if (session) {
                try {
                    await session.endSession();
                } catch (endError) {
                    logger.err("Error ending transaction session", endError);
                }
            }

            // Remove session from request body
            delete req.body.session;

            // Pass error to error handler
            next(error);
        }
    };
}

