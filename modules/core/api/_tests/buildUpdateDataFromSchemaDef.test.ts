import {describe, expect, it} from "vitest";
import {buildCreateDataFromSchemaDef, buildUpdateDataFromSchemaDef} from "../buildUpdateDataFromSchemaDef";

// D115: an emptied local day is "no day", never `""` (which sorts before every real day).
const Def = {
    followUpDate: {type: "string", required: false, format: "localDate"},
    note: {type: "string", required: false},
} as const;

describe("local-day fields in the SchemaDef data builders", () => {
    it("create skips an empty local day and keeps a real one", () => {
        expect(buildCreateDataFromSchemaDef(Def)({followUpDate: "", note: ""})).toEqual({note: ""});
        expect(buildCreateDataFromSchemaDef(Def)({followUpDate: "2026-03-02"})).toEqual({followUpDate: "2026-03-02"});
    });

    it("update clears an emptied local day like null and leaves other strings alone", () => {
        const write = {followUpDate: {}, note: {}};
        expect(buildUpdateDataFromSchemaDef(Def)({followUpDate: "", note: ""}, write)).toEqual({followUpDate: null, note: ""});
        expect(buildUpdateDataFromSchemaDef(Def)({followUpDate: "2026-03-02"}, write)).toEqual({followUpDate: "2026-03-02"});
    });
});
