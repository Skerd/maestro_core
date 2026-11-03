import {ObjectId} from "mongodb";
import {beforeEach, describe, expect, it, vi} from "vitest";

const findOne = vi.hoisted(() => vi.fn());

vi.mock("@coreModule/database/schemas/userSession/userSession.service", () => ({
    userSessionService: {findOne},
}));

vi.mock("@coreModule/environment", () => ({
    CONSTANTS: {DEFAULT_LANGUAGE: "en-US"},
}));

import {validateActiveUserSession} from "../sessionValidator";

const userId = new ObjectId();
const companyId = new ObjectId();
const sessionId = new ObjectId();

const token = {
    id: userId.toString(),
    sessionId: sessionId.toString(),
    username: "a@b.com",
    company: {_id: companyId.toString(), name: "Acme"},
};

describe("validateActiveUserSession", () => {
    beforeEach(() => {
        findOne.mockReset();
    });

    it("rejects a token that does not name a session", async () => {
        await expect(
            validateActiveUserSession({...token, sessionId: undefined}, userId, companyId),
        ).rejects.toMatchObject({error_code: "session_not_found"});
        expect(findOne).not.toHaveBeenCalled();
    });

    it("rejects a revoked or expired session", async () => {
        findOne.mockResolvedValue(null);
        await expect(validateActiveUserSession(token, userId, companyId)).rejects.toMatchObject({
            error_code: "session_not_found",
        });
        const query = findOne.mock.calls[0][0];
        expect(String(query._id)).toBe(sessionId.toString());
        expect(String(query.user)).toBe(userId.toString());
        expect(String(query.company)).toBe(companyId.toString());
        expect(query.isActive).toBe(true);
    });

    it("returns the active session", async () => {
        const doc = {_id: sessionId, isActive: true};
        findOne.mockResolvedValue(doc);
        await expect(validateActiveUserSession(token, userId, companyId)).resolves.toBe(doc);
    });
});
