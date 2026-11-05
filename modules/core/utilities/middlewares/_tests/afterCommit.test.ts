import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {MongoMemoryReplSet} from "mongodb-memory-server";
import mongoose from "mongoose";
import {asyncHandler} from "@coreModule/utilities/middlewares/asyncHandler";
import {flushAfterCommitTasks, runAfterCommit} from "@coreModule/utilities/middlewares/transactionUtils";
import {requestContext} from "@coreModule/utilities/endpoints/requestContext";
import {withTenant} from "@coreModule/utilities/endpoints/tenantScope";
import {transactionHandler} from "@coreModule/utilities/middlewares/transactionHandler";
import {runInTransaction} from "@coreModule/utilities/middlewares/runInTransaction";
import {getLogger} from "@coreModule/loggers/serverLog";
import {emitNotificationEvent, notificationEventBus} from "@coreModule/domain/notifications/notificationEventBus";

// Transactions need a replica set; WiredTiger, because the default in-memory
// test engine has no document-level write conflicts
let replSet: MongoMemoryReplSet;

beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({replSet: {count: 1, storageEngine: "wiredTiger"}});
    await mongoose.connect(replSet.getUri());
}, 120000);

afterAll(async () => {
    await mongoose.disconnect();
    await replSet.stop();
});

const logger = {err: () => undefined, fail: () => undefined, warn: () => undefined};

/** Runs a handler through asyncHandler inside a started transaction, like transactionHandler does. */
async function runHandler(handler: (params: any) => Promise<unknown>): Promise<unknown> {
    const session = await mongoose.startSession();
    session.startTransaction();
    const req: any = {body: {session, logger}, params: {}};
    const res: any = {headersSent: false, status: () => res, json: () => res};
    let forwarded: unknown;
    await asyncHandler(handler)(req, res, (error?: unknown) => { forwarded = error; });
    return forwarded;
}

describe("runAfterCommit", {timeout: 30000}, () => {
    it("runs right away without a transaction", async () => {
        const sent: string[] = [];
        await runAfterCommit(null, async () => { sent.push("now"); });
        expect(sent).toEqual(["now"]);
    });

    it("waits for asyncHandler's commit, and drops the work when the handler fails", async () => {
        const sent: string[] = [];

        await runHandler(async ({session}) => {
            await runAfterCommit(session, async () => { sent.push("committed"); });
            expect(sent).toEqual([]); // still inside the transaction
            return {ok: true};
        });
        const failure = await runHandler(async ({session}) => {
            await runAfterCommit(session, async () => { sent.push("rolled back"); });
            throw new Error("handler failed");
        });

        expect(failure).toBeInstanceOf(Error);
        expect(sent).toEqual(["committed"]);
    });

    it("runs a task in the request context it was queued in, e.g. its tenant (D16)", async () => {
        const seen: (string | undefined)[] = [];
        await runHandler(async ({session}) =>
            withTenant("650000000000000000000a01", () =>
                runAfterCommit(session, async () => { seen.push(requestContext.getStore()?.tenantCompanyId); })));
        expect(seen).toEqual(["650000000000000000000a01"]);
    });

    it("reports a failing task without throwing", async () => {
        const session = await mongoose.startSession();
        session.startTransaction();
        const errors: unknown[] = [];
        await runAfterCommit(session, async () => { throw new Error("mail down"); });
        await session.commitTransaction();

        await flushAfterCommitTasks(session, true, error => errors.push(error));

        expect(errors).toHaveLength(1);
        await session.endSession();
    });
});

describe("asyncHandler transient-error retry (E-21)", {timeout: 30000}, () => {
    const Counter = mongoose.models.RetryCounter
        ?? mongoose.model("RetryCounter", new mongoose.Schema({hits: {type: Number, default: 0}}));

    it("replays the handler in a fresh transaction and keeps only the last attempt's side effects", async () => {
        const counter = await Counter.create({});
        const sent: string[] = [];
        let attempts = 0;

        const failure = await runHandler(async ({session}) => {
            attempts += 1;
            await Counter.updateOne({_id: counter._id}, {$inc: {hits: 1}}, {session});
            await runAfterCommit(session, async () => { sent.push(`attempt ${attempts}`); });
            if (attempts === 1) {
                throw Object.assign(new Error("write conflict"), {hasErrorLabel: (label: string) => label === "TransientTransactionError"});
            }
            return {ok: true};
        });

        expect(failure).toBeUndefined();
        expect(attempts).toBe(2);
        expect(sent).toEqual(["attempt 2"]);
        expect((await Counter.findById(counter._id))!.get("hits")).toBe(1);
    });

    it("recovers from a real write conflict with a concurrent transaction", async () => {
        const counter = await Counter.create({});
        let attempts = 0;

        const failure = await runHandler(async ({session}) => {
            attempts += 1;
            if (attempts === 1) {
                // Another request holds an uncommitted write on the same document
                const other = await mongoose.startSession();
                other.startTransaction();
                await Counter.updateOne({_id: counter._id}, {$inc: {hits: 10}}, {session: other});
                try {
                    await Counter.updateOne({_id: counter._id}, {$inc: {hits: 1}}, {session});
                } finally {
                    await other.abortTransaction();
                    await other.endSession();
                }
            } else {
                await Counter.updateOne({_id: counter._id}, {$inc: {hits: 1}}, {session});
            }
            return {ok: true};
        });

        expect(failure).toBeUndefined();
        expect(attempts).toBe(2);
        expect((await Counter.findById(counter._id))!.get("hits")).toBe(1);
    });

    it("gives up after the last attempt with a retryable 409", async () => {
        let attempts = 0;
        const failure = await runHandler(async () => {
            attempts += 1;
            throw Object.assign(new Error("still conflicting"), {hasErrorLabel: () => true});
        });
        expect(failure).toMatchObject({error_code: "concurrent_request_retry", status: 409});
        expect(attempts).toBe(3);
    });

    it("passes non-transient errors through untouched", async () => {
        const failure = await runHandler(async () => {
            throw new Error("business rule");
        });
        expect(failure).toMatchObject({message: "business rule"});
    });
});

/** A request through transactionHandler and asyncHandler, in its own request context as in production. */
function runRoute(handler: (params: any) => Promise<unknown>): Promise<unknown> {
    const req: any = {body: {logger}, params: {}};
    return requestContext.run({}, () => new Promise((resolve) => {
        // Settles on the answer (asyncHandler's res.json) or on the error passed to next.
        const res: any = {headersSent: false, status: () => res, json: () => resolve(undefined)};
        void transactionHandler()(req, res, (error?: unknown) => {
            if (error) return resolve(error);
            void asyncHandler(handler)(req, res, resolve);
        });
    }));
}

describe("side effects wait for the request's transaction (D06)", {timeout: 30000}, () => {
    const heard: string[] = [];
    const listener = (event: {payload: {label: string}}) => heard.push(event.payload.label);

    beforeAll(() => {
        notificationEventBus.on("D06_TEST_EVENT", listener);
    });
    afterAll(() => {
        notificationEventBus.off("D06_TEST_EVENT", listener);
    });

    const emit = (label: string) => emitNotificationEvent("D06_TEST_EVENT", {receiverIds: ["u1"], payload: {label}});

    it("emits a notification event after the commit, and never for a failed request", async () => {
        heard.length = 0;
        let insideTransaction: string[] = [];
        expect(await runRoute(async () => {
            emit("saved");
            insideTransaction = [...heard];
            return {ok: true};
        })).toBeUndefined();
        expect(insideTransaction).toEqual([]);
        const failure = await runRoute(async () => {
            emit("rolled back");
            throw new Error("handler failed");
        });

        expect(failure).toBeInstanceOf(Error);
        expect(heard).toEqual(["saved"]);
    });

    it("emits only the last attempt's event when a write conflict replays the handler", async () => {
        heard.length = 0;
        let attempts = 0;
        await runRoute(async () => {
            attempts += 1;
            emit(`attempt ${attempts}`);
            if (attempts === 1) {
                throw Object.assign(new Error("write conflict"), {hasErrorLabel: (label: string) => label === "TransientTransactionError"});
            }
            return {ok: true};
        });
        expect(heard).toEqual(["attempt 2"]);
    });

    it("lets runAfterCommit without a session wait for the request's transaction", async () => {
        const sent: string[] = [];
        let insideTransaction: string[] = [];
        expect(await runRoute(async () => {
            await runAfterCommit(undefined, async () => { sent.push("after commit"); });
            insideTransaction = [...sent];
            return {ok: true};
        })).toBeUndefined();
        expect(insideTransaction).toEqual([]);
        expect(sent).toEqual(["after commit"]);
    });

    it("waits for a job's own transaction (runInTransaction)", async () => {
        heard.length = 0;
        let insideTransaction: string[] = [];
        await runInTransaction(getLogger("d06_test"), async () => {
            emit("job saved");
            insideTransaction = [...heard];
        });
        expect(insideTransaction).toEqual([]);
        expect(heard).toEqual(["job saved"]);
    });

    it("emits right away outside any transaction (cron, Kafka, public reads)", () => {
        heard.length = 0;
        emit("no transaction");
        expect(heard).toEqual(["no transaction"]);
    });
});
