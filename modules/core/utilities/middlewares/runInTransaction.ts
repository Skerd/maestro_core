import type {ClientSession} from "mongoose";
import {mongooseInstance} from "@coreModule/connections/connectToMongoDb";
import type {serverLogger} from "@coreModule/loggers/serverLog";
import {flushAfterCommitTasks} from "@coreModule/utilities/middlewares/transactionUtils";
import {requestContext} from "@coreModule/utilities/endpoints/requestContext";
import {openTransactionOnServer} from "@coreModule/utilities/middlewares/transactionHandler";

/**
 * Runs `work` in its own transaction, for code outside a request (webhook
 * handlers, cron jobs). Retries on write conflicts like `asyncHandler` does,
 * dropping after-commit tasks queued by a failed attempt and running them once
 * the transaction has committed. Each attempt's transaction is opened on the
 * server before `work` runs (`openTransactionOnServer`).
 */
export async function runInTransaction<T>(logger: serverLogger, work: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = await mongooseInstance.startSession();
    try {
        let result: T;
        await session.withTransaction(async () => {
            // Each attempt's transaction exists on the server before `work` runs, so it may start with parallel reads (TD-B230).
            await openTransactionOnServer(session);
            await flushAfterCommitTasks(session, false, () => undefined);
            // In the context, so side effects inside `work` wait for this commit (D06).
            result = await requestContext.run({...requestContext.getStore(), session}, () => work(session));
        });
        await flushAfterCommitTasks(session, true, (error) => logger.err("After-commit task failed", error));
        return result!;
    } finally {
        await session.endSession();
    }
}
