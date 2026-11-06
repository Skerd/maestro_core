import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";
import mongoose from "mongoose";

const kafka = vi.hoisted(() => ({connected: false}));
vi.mock("@coreModule/connections/connectToKafka", () => ({isKafkaConnected: () => kafka.connected}));

import {sendAccountEmailAfterCommit} from "@coreModule/utilities/database/user";
import {flushAfterCommitTasks} from "@coreModule/utilities/middlewares/transactionUtils";
import {getLogger, type serverLogger} from "@coreModule/loggers/serverLog";

// TD-B27: account emails (activation, invitation, password reset) went out inside the request transaction, so a
// request that failed afterwards had still mailed a link to a code that was rolled back.

beforeAll(async () => {
    await connectTestDatabase();
}, 120000);

afterAll(async () => {
    await disconnectTestDatabase();
});

beforeEach(() => {
    kafka.connected = false;
});

function recordingLogger(errors: string[]): serverLogger {
    const logger = getLogger("account_email_test");
    logger.err = (message: string) => { errors.push(message); };
    return logger;
}

async function inTransaction(): Promise<mongoose.ClientSession> {
    const session = await mongoose.startSession();
    session.startTransaction();
    return session;
}

describe("sendAccountEmailAfterCommit", {timeout: 30000}, () => {
    it("sends only after the transaction commits", async () => {
        const sent: string[] = [];
        const session = await inTransaction();

        await sendAccountEmailAfterCommit(session, undefined, "activation", async () => false, async () => { sent.push("activation"); });
        expect(sent).toEqual([]);

        await session.commitTransaction();
        await flushAfterCommitTasks(session, true, () => undefined);
        await session.endSession();
        expect(sent).toEqual(["activation"]);
    });

    it("never sends for a rolled-back request", async () => {
        const sent: string[] = [];
        const session = await inTransaction();

        await sendAccountEmailAfterCommit(session, undefined, "invitation", async () => false, async () => { sent.push("invitation"); });
        await session.abortTransaction();
        await flushAfterCommitTasks(session, false, () => undefined);
        await session.endSession();

        expect(sent).toEqual([]);
    });

    it("sends right away when the write had no session (already committed)", async () => {
        const sent: string[] = [];
        await sendAccountEmailAfterCommit(undefined, undefined, "activation", async () => false, async () => { sent.push("now"); });
        expect(sent).toEqual(["now"]);
    });

    it("logs a failed send instead of failing the request", async () => {
        const errors: string[] = [];
        const flushErrors: unknown[] = [];
        const session = await inTransaction();

        await sendAccountEmailAfterCommit(session, recordingLogger(errors), "password reset", async () => false, async () => {
            throw new Error("smtp down");
        });
        await session.commitTransaction();
        await flushAfterCommitTasks(session, true, (error) => flushErrors.push(error));
        await session.endSession();

        expect(flushErrors).toEqual([]);
        expect(errors).toEqual(["Could not send the password reset email"]);
    });

    it("publishes to Kafka after the commit and sends directly when the publish fails", async () => {
        kafka.connected = true;
        const order: string[] = [];
        const session = await inTransaction();

        await sendAccountEmailAfterCommit(
            session,
            undefined,
            "invitation",
            async () => { order.push("publish"); return false; },
            async () => { order.push("direct"); },
        );
        expect(order).toEqual([]);

        await session.commitTransaction();
        await flushAfterCommitTasks(session, true, () => undefined);
        await session.endSession();
        await vi.waitFor(() => expect(order).toEqual(["publish", "direct"]));
    });
});
