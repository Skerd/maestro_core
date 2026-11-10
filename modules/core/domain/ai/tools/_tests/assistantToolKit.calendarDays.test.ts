import {describe, expect, it} from "vitest";

import {
    calendarDayArg,
    calendarDayRange,
    calendarDaysPast,
} from "@coreModule/domain/ai/tools/assistantToolKit";

describe("calendarDayArg", () => {
    it("keeps a day as written and an instant's date part, whatever its offset", () => {
        expect(calendarDayArg.parse("2026-03-01")).toBe("2026-03-01");
        expect(calendarDayArg.parse(" 2026-03-01T23:30:00-05:00 ")).toBe("2026-03-01");
    });

    it("rejects text that is not a day", () => {
        expect(calendarDayArg.safeParse("March 1st").success).toBe(false);
        expect(calendarDayArg.safeParse("2026-13-01").success).toBe(false);
    });
});

describe("calendarDayRange", () => {
    it("builds an inclusive string clause from either bound", () => {
        expect(calendarDayRange("2026-03-01", "2026-03-31")).toEqual({$gte: "2026-03-01", $lte: "2026-03-31"});
        expect(calendarDayRange(undefined, "2026-03-31")).toEqual({$lte: "2026-03-31"});
        expect(calendarDayRange()).toBeUndefined();
    });
});

describe("calendarDaysPast", () => {
    it("counts whole days before today, across a DST change", () => {
        expect(calendarDaysPast("2026-03-28", "2026-04-02")).toBe(5);
        expect(calendarDaysPast("2026-04-02", "2026-04-02")).toBe(0);
        expect(calendarDaysPast("2026-04-05", "2026-04-02")).toBe(-3);
    });

    it("is null without a day", () => {
        expect(calendarDaysPast(undefined, "2026-04-02")).toBeNull();
        expect(calendarDaysPast("", "2026-04-02")).toBeNull();
        expect(calendarDaysPast("soon", "2026-04-02")).toBeNull();
    });
});
