import {NextFunction, Request, Response} from 'express';
import {ClientSession} from 'mongoose';
import {getLogger, serverLogger} from '@coreModule/loggers/serverLog';
import {getGridFSStorage} from '@coreModule/utilities/gridfs/gridfsStorage';

/**
 * Async Handler Middleware
 * 
 * Wraps async route handlers with error handling and transaction support.
 * If a transaction session exists (from transactionHandler), it will automatically
 * commit on success or abort on error.
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

            // Execute the handler function
            let returnThis: any = await fn(req.body, req.params, req, res);

            // If a transaction exists and is still active, commit it
            if (session && session.inTransaction()) {
                try {
                    // logger.debug("Committing transaction...");
                    await session.commitTransaction();
                    // logger.debug("Transaction committed successfully");
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
                    throw commitError;
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
