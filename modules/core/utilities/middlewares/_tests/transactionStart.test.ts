import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";
import mongoose, {type ClientSession} from "mongoose";
import {asyncHandler} from "@coreModule/utilities/middlewares/asyncHandler";
import {openTransactionOnServer, transactionHandler} from "@coreModule/utilities/middlewares/transactionHandler";
import {runInTransaction} from "@coreModule/utilities/middlewares/runInTransaction";
import {requestContext} from "@coreModule/utilities/endpoints/requestContext";
import {getLogger} from "@coreModule/loggers/serverLog";

// TD-B230: the driver sends `startTransaction` only with a transaction's first command, so two commands sent at once
// as the first ones (`Promise.all` reads on the session) could reach the server in either order, and the one without
// the flag failed with NoSuchTransaction. Core now opens the transaction on the server before any handler code runs.

beforeAll(async () => {
    await connectTestDatabase();
}, 120000);

afterAll(async () => {
    await disconnectTestDatabase();
});

const logger = {err: () => undefined, fail: () => undefined, warn: () => undefined};

const Shelf = mongoose.models.TransactionStartShelf
    ?? mongoose.model("TransactionStartShelf", new mongoose.Schema({label: String, count: {type: Number, default: 0}}));
const Box = mongoose.models.TransactionStartBox
    ?? mongoose.model("TransactionStartBox", new mongoose.Schema({shelf: mongoose.Schema.Types.ObjectId, label: String}));

/** The transaction number the server holds open for this session, read from another connection's view ($currentOp). */
async function serverTransactionNumber(session: ClientSession): Promise<number | undefined> {
    const lsid = session.id;
    if (!lsid) return undefined;
    const ops = await mongoose.connection.getClient().db("admin")
        .aggregate([{$currentOp: {idleSessions: true, allUsers: true}}, {$match: {"lsid.id": lsid.id, transaction: {$exists: true}}}])
        .toArray();
    const txnNumber = ops[0]?.transaction?.parameters?.txnNumber;
    return txnNumber === undefined ? undefined : Number(txnNumber);
}

/** A request through transactionHandler and asyncHandler, in its own request context as in production. */
function runRoute(handler: (params: {session: ClientSession}) => Promise<unknown>): Promise<unknown> {
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

describe("the transaction exists on the server before handler code runs (TD-B230)", {timeout: 30000}, () => {
    it("transactionHandler opens it before the handler's first line", async () => {
        let seen: number | undefined;
        const failure = await runRoute(async ({session}) => {
            seen = await serverTransactionNumber(session);
            return {ok: true};
        });

        expect(failure).toBeUndefined();
        expect(seen).toBeTypeOf("number");
    });

    it("asyncHandler opens the fresh transaction of a replay before the handler runs again", async () => {
        const seen: (number | undefined)[] = [];
        const failure = await runRoute(async ({session}) => {
            seen.push(await serverTransactionNumber(session));
            if (seen.length === 1) {
                throw Object.assign(new Error("write conflict"), {hasErrorLabel: (label: string) => label === "TransientTransactionError"});
            }
            return {ok: true};
        });

        expect(failure).toBeUndefined();
        expect(seen).toHaveLength(2);
        expect(seen[1]).toBeTypeOf("number");
        expect(seen[1]).toBeGreaterThan(seen[0]!);
    });

    it("runInTransaction opens it before the work runs", async () => {
        let seen: number | undefined;
        await runInTransaction(getLogger("td_b230_test"), async (session) => {
            seen = await serverTransactionNumber(session);
        });
        expect(seen).toBeTypeOf("number");
    });

    it("commits handlers that start with parallel reads on the session, many at once", async () => {
        const shelf = await Shelf.create({label: "A"});
        const requests = Array.from({length: 20}, (_, i) => runRoute(async ({session}) => {
            const [found] = await Promise.all([
                Shelf.findById(shelf._id).session(session),
                Box.findOne({shelf: shelf._id}).session(session),
                Box.countDocuments({shelf: shelf._id}).session(session),
            ]);
            await Box.create([{shelf: found!._id, label: `box ${i}`}], {session});
            return {ok: true};
        }));

        expect(await Promise.all(requests)).toEqual(Array.from({length: 20}, () => undefined));
        expect(await Box.countDocuments({shelf: shelf._id})).toBe(20);
        // The opening read never creates its collection.
        expect(await mongoose.connection.db.listCollections({name: "_transactionStart"}).toArray()).toEqual([]);
    });

    it("leaves a session without a transaction alone", async () => {
        const session = await mongoose.startSession();
        try {
            await openTransactionOnServer(session);
            await Shelf.findOne({}).session(session);
            expect(session.inTransaction()).toBe(false);
            expect(await serverTransactionNumber(session)).toBeUndefined();
        } finally {
            await session.endSession();
        }
    });
});
