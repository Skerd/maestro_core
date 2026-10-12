import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {MongoMemoryReplSet} from "mongodb-memory-server";
import mongoose from "mongoose";
import {asyncHandler} from "@coreModule/utilities/middlewares/asyncHandler";
import {flushAfterCommitTasks, runAfterCommit} from "@coreModule/utilities/middlewares/transactionUtils";

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

    it("gives up after the last attempt", async () => {
        let attempts = 0;
        const failure = await runHandler(async () => {
            attempts += 1;
            throw Object.assign(new Error("still conflicting"), {hasErrorLabel: () => true});
        });
        expect(failure).toBeInstanceOf(Error);
        expect(attempts).toBe(3);
    });
});
