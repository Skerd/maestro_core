import {ClientSession} from 'mongoose';
import {AuthenticatedMWType} from './authMW';
import {requestContext} from "@coreModule/utilities/endpoints/requestContext";

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

/** Work waiting for a session's transaction to commit (see {@link runAfterCommit}). */
const commitTasks = new WeakMap<ClientSession, (() => Promise<void>)[]>();

/** How long a stopping server waits for after-commit work before it closes its connections (D188). */
export const SHUTDOWN_AFTER_COMMIT_WAIT_MS = 10_000;

/** After-commit work still running (emails, Kafka publishes): stopping a server waits for it (D188). */
const pendingAfterCommit = new Set<Promise<unknown>>();

/** Keeps `work` until it settles, so {@link settleAfterCommitWork} waits for it; for work started without being awaited. */
export function keepUntilSettled(work: Promise<unknown>): void {
    pendingAfterCommit.add(work);
    work.finally(() => pendingAfterCommit.delete(work)).catch(() => undefined);
}

/**
 * Waits, at most `timeoutMs`, for the after-commit work still running, so stopping the API or cron server does not cut
 * an email off between its commit and its send or publish (D188). Work started meanwhile is not waited for.
 */
export async function settleAfterCommitWork(timeoutMs: number): Promise<void> {
    if (pendingAfterCommit.size === 0) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
        Promise.allSettled([...pendingAfterCommit]),
        new Promise<void>((resolve) => {
            timer = setTimeout(resolve, timeoutMs);
        }),
    ]);
    clearTimeout(timer);
}

/**
 * Runs `task` only once the session's transaction has committed, or right away
 * when there is no transaction. Use it for side effects that must not happen
 * for rolled-back work, such as emails and push notifications. Without a
 * `session` it waits for the request's own transaction (`requestContext`, D06).
 *
 * Whoever commits flushes the queue with {@link flushAfterCommitTasks}:
 * `asyncHandler` does so for routes using `transactionHandler`; code that runs
 * its own `withTransaction` must do the same (dropping at the start of each
 * attempt, running after it resolves). The task runs in the request context it was queued in.
 */
export async function runAfterCommit(given: ClientSession | null | undefined, task: () => Promise<void>): Promise<void> {
    const session = given ?? requestContext.getStore()?.session;
    if (!session?.inTransaction()) {
        await task();
        return;
    }
    const tasks = commitTasks.get(session) ?? [];
    // The task runs later, after the handler returned: it keeps the context it was queued in, so it
    // works on the same tenant (D16) and as the same user.
    const store = requestContext.getStore();
    tasks.push(store ? () => requestContext.run(store, task) : task);
    commitTasks.set(session, tasks);
}

/**
 * Runs (after a commit) or drops (after an abort, or before a retry) the tasks
 * queued with {@link runAfterCommit}. A failing task is logged, never thrown:
 * the transaction is already settled.
 */
export async function flushAfterCommitTasks(
    session: ClientSession,
    committed: boolean,
    onError: (error: unknown) => void,
): Promise<void> {
    const tasks = commitTasks.get(session) ?? [];
    commitTasks.delete(session);
    if (!committed || tasks.length === 0) return;
    const run = (async () => {
        for (const task of tasks) {
            try {
                await task();
            } catch (error) {
                onError(error);
            }
        }
    })();
    keepUntilSettled(run);
    await run;
}
