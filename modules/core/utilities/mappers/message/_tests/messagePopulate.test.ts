import {describe, expect, it} from "vitest";
import {Types} from "mongoose";
import Message from "@coreModule/database/schemas/message/message";
import SchemaGuard from "@coreModule/database/security/schemaGuard";
import {getModelCollectedData} from "@coreModule/database/collections";
import {allPermissionTags} from "@coreModule/_tests/httpHarness";
import type {UserContext} from "@coreModule/utilities/types/types";
import {messagePopulate} from "../messagePopulate";

type PopulateEntry = {path?: string; select?: string};

/** The fields a reader holding every Message permission reads, as the message routes compute them. */
function readerFields() {
    const ctx: UserContext = {userId: new Types.ObjectId().toString(), orgId: new Types.ObjectId().toString(), isAdmin: false, permissions: allPermissionTags([Message]), isSelf: true};
    return SchemaGuard.sanitizeFields(Message, getModelCollectedData("messages").readFields!, "read", ctx);
}

function replyToEntry(populate: unknown): PopulateEntry | undefined {
    const entries = (Array.isArray(populate) ? populate : [populate]) as PopulateEntry[];
    return entries.find((entry) => entry?.path === "replyTo");
}

describe("messagePopulate", () => {
    it("loads the replied-to message's status, which no role reads, so its quote can show the text", () => {
        const fields = readerFields();
        const plain = replyToEntry(SchemaGuard.generatePopulate(fields, Message.schema).populate);
        expect(plain?.select).toBeDefined();
        expect(plain?.select?.split(" ")).not.toContain("status");

        const withStatus = replyToEntry(messagePopulate(fields).populate);
        expect(withStatus?.select?.split(" ")).toContain("status");
        expect(withStatus?.select?.split(" ")).toContain("text");
    });

    it("adds it once", () => {
        const select = replyToEntry(messagePopulate(readerFields()).populate)?.select ?? "";
        expect(select.split(" ").filter((field) => field === "status")).toHaveLength(1);
    });
});
