import {NextFunction, Request, Response} from 'express';
import {ClientSession} from 'mongoose';
import {mongooseInstance} from '@coreModule/connections/connectToMongoDb';
import {getLogger, serverLogger} from '@coreModule/loggers/serverLog';
import {requestContext} from '@coreModule/utilities/endpoints/requestContext';

/** Never created: reading it touches no data and takes no lock on a real collection. */
const TRANSACTION_START_COLLECTION = "_transactionStart";

/**
 * Opens a just-started transaction on the server with one awaited read, so code that follows may send
 * several commands on the session at once (`Promise.all`) from its first line (TD-B230, D158).
 *
 * Why: `startTransaction()` only marks the session; the driver (4.17) adds `startTransaction: true` to the
 * transaction's first command alone. When two commands go out together as the first ones, they travel on
 * separate pooled connections and may reach the server in either order; the one without the flag arriving
 * first fails with `NoSuchTransaction` (251), which under load outlived every retry (TD-B229). A find on a
 * collection that never exists opens the transaction like any other command, at the cost of one round trip
 * (about 0.6-0.9 ms locally): it writes nothing, creates nothing, locks no real collection and reads only
 * the app's own database.
 *
 * Call it right after every `startTransaction()` (each replay too). On a session without a transaction it
 * does nothing, so sessions used for plain reads are left alone.
 */
export async function openTransactionOnServer(session: ClientSession): Promise<void> {
    if (!session.inTransaction()) return;
    await mongooseInstance.connection.db.collection(TRANSACTION_START_COLLECTION).findOne({}, {session, projection: {_id: 1}});
}

/**
 * Transaction Middleware
 * 
 * Wraps endpoints with MongoDB transaction support.
 * Automatically starts a transaction session and attaches it to req.body.
 * The transaction is already open on the server when the handler runs
 * (`openTransactionOnServer`), so the handler may start with parallel reads.
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

            // Start transaction, on the server too, before any later middleware or the handler runs
            session.startTransaction();
            await openTransactionOnServer(session);

            // Attach session to request body so handlers can access it
            // This is the single source of truth for transaction sessions
            req.body.session = session;
            // Core code below the handler (the notification bus, runAfterCommit) finds it here (D06).
            const store = requestContext.getStore();
            if (store) store.session = session;

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

