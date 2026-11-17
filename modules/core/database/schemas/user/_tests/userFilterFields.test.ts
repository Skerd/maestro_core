import {describe, expect, it} from "vitest";
import User from "@coreModule/database/schemas/user/user";

type TableOptions = {dynamicTableConfiguration?: {filterable?: boolean}};

// TD-F121: the users list offered ~40 technical fields as filters ("isBot", "MFA deactivation locked until",
// "Password reset attempts", …).
describe("user filter fields", () => {
    it("offers no request counters, lock dates or the bot flag", () => {
        const offered: string[] = [];
        User.schema.eachPath((path, type) => {
            if ((type.options as TableOptions).dynamicTableConfiguration?.filterable !== false) offered.push(path);
        });
        expect(offered.filter((path) => path.startsWith("requests.") || path === "isBot")).toEqual([]);
        const roles = (User.schema.path("roles") as unknown as {schema: {path: (p: string) => {options: TableOptions}}}).schema;
        for (const path of ["unsuccessfulLogins", "lockedOutUntil"]) {
            expect(roles.path(path).options.dynamicTableConfiguration?.filterable).toBe(false);
        }
    });
});
