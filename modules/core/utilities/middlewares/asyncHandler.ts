import {NextFunction, Request, Response} from 'express';
import {ClientSession} from 'mongoose';
import {getLogger, serverLogger} from '@coreModule/loggers/serverLog';
import {getGridFSStorage} from '@coreModule/utilities/gridfs/gridfsStorage';
import {flushAfterCommitTasks} from '@coreModule/utilities/middlewares/transactionUtils';
import {apiValidationException} from 'armonia/src/modules/core/helpers/exceptions';

/** Attempts per request before a transient transaction error is passed on. */
const MAX_TRANSACTION_ATTEMPTS = 3;

/** MongoDB labels errors that are safe to retry (write conflicts, unknown commit outcomes). */
function hasErrorLabel(error: unknown, label: "TransientTransactionError" | "UnknownTransactionCommitResult"): boolean {
    const labelled = error as {hasErrorLabel?: (label: string) => boolean} | null;
    return typeof labelled?.hasErrorLabel === "function" && labelled.hasErrorLabel(label);
}

/**
 * A write conflict that outlived every retry: tell the caller to try again (409)
 * instead of letting it surface as a generic 500.
 */
function concurrentRequestError(req: Request) {
    return apiValidationException("concurrent_request_retry", "", null, req.body?.languageCode || "en-US");
}

/** Commits, retrying while the server can't say whether the commit happened (committing twice is safe). */
async function commitWithRetry(session: ClientSession): Promise<void> {
    for (let attempt = 1; ; attempt++) {
        try {
            await session.commitTransaction();
            return;
        } catch (error) {
            if (attempt >= MAX_TRANSACTION_ATTEMPTS || !hasErrorLabel(error, "UnknownTransactionCommitResult")) throw error;
        }
    }
}

/**
 * Async Handler Middleware
 * 
 * Wraps async route handlers with error handling and transaction support.
 * If a transaction session exists (from transactionHandler), it will automatically
 * commit on success or abort on error. A transient transaction error (e.g. a
 * write conflict with a concurrent request) re-runs the handler in a fresh
 * transaction, up to MAX_TRANSACTION_ATTEMPTS times; work queued with
 * `runAfterCommit` by a failed attempt is dropped. Handlers must therefore be
 * safe to replay: gateway calls inside them carry idempotency keys.
 * 
 * @param fn - The async handler function
 * @param notify - Optional notification flag (reserved for future use)
 * @returns Express middleware function
 */
export function asyncHandler(fn: (params: any, queryParams: any, req: any, res: Response) => Promise<unknown>, notify: boolean = false) {
    return async (req: Request, res: Response, next: NextFunction) => {
        const logger: serverLogger = req.body?.logger || getLogger("async_handler");
        // Single source of truth: session is always in req.body.session
        const session: ClientSession | undefined = req.body?.session;

        try {

            // Execute the handler function, replaying it after a transient transaction error
            let returnThis: any;
            for (let attempt = 1; ; attempt++) {
                try {
                    returnThis = await fn(req.body, req.params, req, res);
                    break;
                } catch (error) {
                    if (!session?.inTransaction() || res.headersSent || !hasErrorLabel(error, "TransientTransactionError")) {
                        throw error;
                    }
                    if (attempt >= MAX_TRANSACTION_ATTEMPTS) {
                        throw concurrentRequestError(req);
                    }
                    logger.warn(`Transient transaction error, retrying (attempt ${attempt + 1}/${MAX_TRANSACTION_ATTEMPTS})`);
                    await session.abortTransaction();
                    await flushAfterCommitTasks(session, false, () => undefined);
                    session.startTransaction();
                }
            }

            // If a transaction exists and is still active, commit it
            if (session && session.inTransaction()) {
                try {
                    // logger.debug("Committing transaction...");
                    await commitWithRetry(session);
                    // logger.debug("Transaction committed successfully");
                    await flushAfterCommitTasks(session, true, error => logger.err("After-commit task failed", error));
                } catch (commitError: any) {
                    logger.err("Error committing transaction", commitError);
                    // If the commit fails: clean up GridFS then abort
                    try {
                        const gridFsIds = (req.body as any)?._mediaUploadGridFsIds as string[] | undefined;
                        if (gridFsIds?.length) {
                            const languageCode = (req as any).header?.("language") || "en-US";
                            const gridfs = getGridFSStorage(languageCode, 'media', logger);
                            for (const id of gridFsIds) {
                                try {
                                    await gridfs.deleteFile(id);
                                } catch (delErr: any) {
                                    logger.warn(`Failed to clean up GridFS file ${id} on commit failure: ${delErr.message}`);
                                }
                            }
                        }
                        await session.abortTransaction();
                    } catch (abortError: any) {
                        logger.err("Error aborting transaction after commit failure", abortError);
                    }
                    await flushAfterCommitTasks(session, false, () => undefined);
                    throw hasErrorLabel(commitError, "TransientTransactionError") ? concurrentRequestError(req) : commitError;
                }
            }

            if( notify ){
                // Reserved for future notification functionality
            }
            
            // Skip JSON response when already sent (e.g. streaming media)
            if (!res.headersSent) {
                return res.status(200).json(returnThis);
            }
        }
        catch (e: any) {
            logger.fail(e);

            // If a transaction exists and is still active: clean up GridFS uploads then abort
            // (Media docs roll back; GridFS does not participate in transactions, so we delete explicitly)
            if (session && session.inTransaction()) {
                try {
                    const gridFsIds = (req.body as any)?._mediaUploadGridFsIds as string[] | undefined;
                    if (gridFsIds?.length) {
                        const languageCode = (req as any).header?.("language") || "en-US";
                        const gridfs = getGridFSStorage(languageCode, 'media', logger);
                        for (const id of gridFsIds) {
                            try {
                                await gridfs.deleteFile(id);
                            } catch (delErr: any) {
                                logger.warn(`Failed to clean up GridFS file ${id} on rollback: ${delErr.message}`);
                            }
                        }
                    }
                    await session.abortTransaction();
                } catch (abortError: any) {
                    logger.err("Error aborting transaction", abortError);
                }
                await flushAfterCommitTasks(session, false, () => undefined);
            }

            // Pass error to error handler
            next(e);
        }
        finally {
            // End a session if it exists (cleanup)
            if (session) {
                try {
                    await session.endSession();
                    // logger.debug("Transaction session ended");
                } catch (endError: any) {
                    logger.err("Error ending transaction session", endError);
                }
            }
        }
    };
}
