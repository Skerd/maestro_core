import {describe, expect, it} from "vitest";
import {buildCreateDataFromSchemaDef} from "../buildUpdateDataFromSchemaDef";

const DateSchemaDef = {
    dueDate: {type: "date", required: true},
    scheduledAt: {type: "date", required: true},
} as const;

describe("parseSchemaDate via buildCreateDataFromSchemaDef", () => {
    const build = buildCreateDataFromSchemaDef(DateSchemaDef);

    it("stores a date-only string as UTC midnight", () => {
        expect(build({dueDate: "2026-03-15"}).dueDate.toISOString()).toBe("2026-03-15T00:00:00.000Z");
    });

    it("stores an ISO instant as that instant", () => {
        const iso = "2026-03-15T13:00:00.000Z";
        expect(build({scheduledAt: iso}).scheduledAt.toISOString()).toBe(iso);
    });
});
