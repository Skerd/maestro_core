import type {ClientSession} from "mongoose";
import {mongooseInstance} from "@coreModule/connections/connectToMongoDb";
import type {serverLogger} from "@coreModule/loggers/serverLog";
import {flushAfterCommitTasks} from "@coreModule/utilities/middlewares/transactionUtils";

/**
 * Runs `work` in its own transaction, for code outside a request (webhook
 * handlers, cron jobs). Retries on write conflicts like `asyncHandler` does,
 * dropping after-commit tasks queued by a failed attempt and running them once
 * the transaction has committed.
 */
export async function runInTransaction<T>(logger: serverLogger, work: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = await mongooseInstance.startSession();
    try {
        let result: T;
        await session.withTransaction(async () => {
            await flushAfterCommitTasks(session, false, () => undefined);
            result = await work(session);
        });
        await flushAfterCommitTasks(session, true, (error) => logger.err("After-commit task failed", error));
        return result!;
    } finally {
        await session.endSession();
    }
}
