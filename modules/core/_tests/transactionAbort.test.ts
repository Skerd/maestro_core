import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";
import {Router} from "express";
import mongoose, {type ClientSession} from "mongoose";
import {ObjectId} from "mongodb";
import bcrypt from "bcrypt";
import request from "supertest";
import {appFor} from "@coreModule/_tests/httpHarness";
import {asyncHandler} from "@coreModule/utilities/middlewares/asyncHandler";
import {transactionHandler} from "@coreModule/utilities/middlewares/transactionHandler";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import Company from "@coreModule/database/schemas/company/company";
import User from "@coreModule/database/schemas/user/user";

// TD-B97: a handler that writes with the request's session and then fails answers with its error, and its write is
// rolled back. A failed password check counts the attempt outside the transaction (the request rolls back); when
// the transaction had already written the same user, that count waited on the transaction's lock while the
// transaction waited on the handler, so the request hung until the server's transaction lifetime limit (60 s).
const companyId = new ObjectId();
const userId = new ObjectId();
const password = "Secret#Pass1";

const router = Router();
router.post("/write-then-throw", transactionHandler(), asyncHandler(async ({session}: {session: ClientSession}) => {
    await Company.collection.updateOne({_id: companyId}, {$set: {name: "Renamed"}}, {session});
    throw apiValidationException("invalid_credentials", null, null, "en-US");
}));
router.post("/write-user-then-wrong-password", transactionHandler(), asyncHandler(async ({session}: {session: ClientSession}) => {
    // What D101's first draft did: join the user to a company inside the transaction before the password check.
    await User.collection.updateOne({_id: userId}, {$set: {name: "Joined"}}, {session});
    const user = (await User.findById(userId).session(session))!;
    await user.checkPassword(companyId, "Wrong#Pass1", "en-US");
}));
const app = appFor([{basePath: "/tx", router, module: "core"}]);

beforeAll(async () => {
    await connectTestDatabase();
}, 120000);

afterAll(async () => {
    await disconnectTestDatabase();
});

beforeEach(async () => {
    for (const collection of await mongoose.connection.db!.collections()) {
        await collection.deleteMany({});
    }
    await Company.collection.insertOne({_id: companyId, company: companyId, name: "Estates", vat: "E", allowedDomains: ["*"], isActive: true, deletedAt: null});
    await User.collection.insertOne({
        _id: userId, username: "pat@estates.com", password: await bcrypt.hash(password, 10), name: "Pat", surname: "Manager",
        fullName: "Pat Manager", isEmailVerified: true, companies: [companyId], mfaSecret: "",
        roles: [{_id: new ObjectId(), company: companyId, roles: [], rolesCount: 0, active: "active", unsuccessfulLogins: 0, lockedOutUntil: null}],
    });
});

// Far below the server's 60 s transaction lifetime limit, which is what ended the hang.
const post = (path: string) => request(app).post(`/tx${path}`).send({}).timeout(5000);

describe("a transactional handler that fails after a write (TD-B97)", () => {
    it("answers with its error and rolls the write back", async () => {
        const res = await post("/write-then-throw");

        expect([res.status, res.body.error_code]).toEqual([403, "invalid_credentials"]);
        expect((await Company.collection.findOne({_id: companyId}))!.name).toBe("Estates");
    });

    it("answers a wrong password after writing the same user, rolls the write back and still counts the attempt", async () => {
        const res = await post("/write-user-then-wrong-password");

        expect([res.status, res.body.error_code]).toEqual([403, "invalid_credentials"]);
        // The count is not awaited by the request: it lands once the transaction has rolled back.
        await vi.waitFor(async () => {
            const user = (await User.collection.findOne({_id: userId}))!;
            expect([user.name, user.roles[0].unsuccessfulLogins]).toEqual(["Pat", 1]);
        }, {timeout: 2000});
    });
});
