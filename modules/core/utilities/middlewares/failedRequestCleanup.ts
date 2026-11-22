import {NextFunction, Request, Response} from 'express';
import {ClientSession} from 'mongoose';
import {getLogger, serverLogger} from '@coreModule/loggers/serverLog';
import {mediaService} from '@coreModule/database/schemas/media/media.service';
import {rollBackRequestTransaction} from '@coreModule/utilities/middlewares/asyncHandler';

const cleanedUp = new WeakSet<Request>();

async function cleanUp(req: Request, logger: serverLogger): Promise<void> {
    const session: ClientSession | undefined = req.body?.session;
    if (session?.inTransaction()) {
        // A middleware failed after transactionHandler (asyncHandler rolls back its own handler's failures).
        await rollBackRequestTransaction(req, session, logger);
        await session.endSession();
        return;
    }
    // Without a transaction nothing rolled back: a record saved before the failure may already point at the uploads,
    // so they go to the orphan cleanup, which deletes only those nothing references (TD-B249).
    const mediaIds: string[] | undefined = req.body?._mediaUploadMediaIds;
    if (mediaIds?.length) await mediaService.markPendingReference(mediaIds);
}

/**
 * Error middleware mounted after every router (`routeRegistry`, and the test harness like it): whichever step of a
 * request failed after `transactionHandler` or `mediaUploadMW` ran (a middleware such as `validateFormZod` refusing
 * the form, or the handler), an open transaction is rolled back and the session ended, and uploads that did not roll
 * back are handed to `core.orphanUploadCleanup` (TD-B251). Then the error goes on to the app's error handler.
 */
export function failedRequestCleanup(error: unknown, req: Request, _res: Response, next: NextFunction): void {
    // Routers sharing a path each mount this; an error passes through all of them.
    if (cleanedUp.has(req)) return next(error);
    cleanedUp.add(req);
    const logger: serverLogger = req.body?.logger || getLogger("failed_request_cleanup");
    cleanUp(req, logger)
        .catch((cleanupError: unknown) => logger.warn(`Cleaning up after a failed request failed: ${cleanupError}`))
        .finally(() => next(error));
}
