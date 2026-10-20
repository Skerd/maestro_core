import {describe, expect, it} from "vitest";
import {
    addLocalDays,
    expandWeeklyHours,
    intersectIntervals,
    isCovered,
    isValidTimeZone,
    localDayInterval,
    localDateOf,
    localToUtc,
    mergeIntervals,
    overlaps,
    subtractIntervals,
    type TimeInterval,
} from "@coreModule/utilities/time/timeWindows";

const at = (iso: string) => new Date(iso);
const span = (start: string, end: string): TimeInterval => ({start: at(start), end: at(end)});
const iso = (intervals: TimeInterval[]) => intervals.map((i) => [i.start.toISOString(), i.end.toISOString()]);

describe("localToUtc", () => {
    it.each([
        ["2026-06-01", "09:00", "Europe/Tirane", "2026-06-01T07:00:00.000Z"],
        ["2026-01-15", "09:00", "Europe/Zurich", "2026-01-15T08:00:00.000Z"],
        ["2026-07-04", "12:00", "America/New_York", "2026-07-04T16:00:00.000Z"],
    ])("converts %s %s in %s", (date, time, zone, expected) => {
        expect(localToUtc(date, time, zone)?.toISOString()).toBe(expected);
    });

    it.each([
        ["2026-03-29", "02:30", "Europe/Zurich"],
        ["2026-03-29", "02:00", "Europe/Tirane"],
        ["2026-03-08", "02:30", "America/New_York"],
    ])("rejects %s %s in %s (skipped by spring-forward)", (date, time, zone) => {
        expect(localToUtc(date, time, zone)).toBeNull();
    });

    it.each([
        ["2026-10-25", "02:30", "Europe/Zurich", "2026-10-25T00:30:00.000Z"],
        ["2026-11-01", "01:30", "America/New_York", "2026-11-01T05:30:00.000Z"],
    ])("resolves the repeated %s %s in %s to the earlier instant", (date, time, zone, expected) => {
        expect(localToUtc(date, time, zone)?.toISOString()).toBe(expected);
    });

    it("rejects malformed input", () => {
        expect(localToUtc("2026-02-30", "09:00", "Europe/Zurich")).toBeNull();
    });
});

describe("isValidTimeZone / localDateOf", () => {
    it("accepts IANA zones and rejects anything else", () => {
        expect(isValidTimeZone("Europe/Zurich")).toBe(true);
        expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    });

    it("reports the local calendar date, not the UTC one", () => {
        expect(localDateOf(at("2026-06-01T23:30:00Z"), "Europe/Zurich")).toBe("2026-06-02");
        expect(localDateOf(at("2026-06-02T03:00:00Z"), "America/New_York")).toBe("2026-06-01");
    });
});

describe("expandWeeklyHours", () => {
    const weekdays = [1, 2, 3, 4, 5].map((dayOfWeek) => ({dayOfWeek, startTime: "08:00", endTime: "18:00"}));

    it("expands Monday–Friday hours across a week, skipping the weekend", () => {
        // Mon 2026-06-01 … Sun 2026-06-07, Zurich is UTC+2 in summer
        const result = expandWeeklyHours(weekdays, "Europe/Zurich", at("2026-06-01T00:00:00Z"), at("2026-06-08T00:00:00Z"));
        expect(result).toHaveLength(5);
        expect(iso(result)[0]).toEqual(["2026-06-01T06:00:00.000Z", "2026-06-01T16:00:00.000Z"]);
        expect(iso(result)[4]).toEqual(["2026-06-05T06:00:00.000Z", "2026-06-05T16:00:00.000Z"]);
    });

    it("keeps wall-clock hours across the spring-forward weekend (10 real hours either side)", () => {
        // Fri 27 Mar (UTC+1) and Mon 30 Mar (UTC+2) 2026
        const result = expandWeeklyHours(weekdays, "Europe/Zurich", at("2026-03-27T00:00:00Z"), at("2026-03-31T00:00:00Z"));
        expect(iso(result)).toEqual([
            ["2026-03-27T07:00:00.000Z", "2026-03-27T17:00:00.000Z"],
            ["2026-03-30T06:00:00.000Z", "2026-03-30T16:00:00.000Z"],
        ]);
    });

    it("gives a day that crosses fall-back its extra real hour", () => {
        const sunday = [{dayOfWeek: 0, startTime: "00:00", endTime: "24:00"}];
        const [day] = expandWeeklyHours(sunday, "Europe/Zurich", at("2026-10-24T00:00:00Z"), at("2026-10-27T00:00:00Z"));
        expect(day.end.getTime() - day.start.getTime()).toBe(25 * 3600 * 1000);
    });

    it("opens a row that starts inside the skipped hour at the first real minute", () => {
        const sunday = [{dayOfWeek: 0, startTime: "02:30", endTime: "05:00"}];
        const [day] = expandWeeklyHours(sunday, "Europe/Zurich", at("2026-03-28T00:00:00Z"), at("2026-03-30T00:00:00Z"));
        expect(day.end.toISOString()).toBe("2026-03-29T03:00:00.000Z");
        expect(day.end.getTime() - day.start.getTime()).toBe(1.5 * 3600 * 1000);
    });

    it("clips to the window, merges split rows and ignores inverted rows", () => {
        const rows = [
            {dayOfWeek: 1, startTime: "08:00", endTime: "12:00"},
            {dayOfWeek: 1, startTime: "12:00", endTime: "17:00"},
            {dayOfWeek: 1, startTime: "19:00", endTime: "18:00"},
        ];
        const result = expandWeeklyHours(rows, "UTC", at("2026-06-01T10:00:00Z"), at("2026-06-01T15:00:00Z"));
        expect(iso(result)).toEqual([["2026-06-01T10:00:00.000Z", "2026-06-01T15:00:00.000Z"]]);
    });
});

describe("interval arithmetic", () => {
    const day = [span("2026-06-01T08:00:00Z", "2026-06-01T18:00:00Z")];

    it("treats touching intervals as not overlapping", () => {
        expect(overlaps(span("2026-06-01T08:00:00Z", "2026-06-01T10:00:00Z"), span("2026-06-01T10:00:00Z", "2026-06-01T11:00:00Z"))).toBe(false);
        expect(overlaps(span("2026-06-01T08:00:00Z", "2026-06-01T10:01:00Z"), span("2026-06-01T10:00:00Z", "2026-06-01T11:00:00Z"))).toBe(true);
    });

    it("merges touching intervals", () => {
        expect(iso(mergeIntervals([span("2026-06-01T10:00:00Z", "2026-06-01T11:00:00Z"), span("2026-06-01T08:00:00Z", "2026-06-01T10:00:00Z")])))
            .toEqual([["2026-06-01T08:00:00.000Z", "2026-06-01T11:00:00.000Z"]]);
    });

    it("subtracts a lunch break and an appointment", () => {
        const free = subtractIntervals(day, [
            span("2026-06-01T12:00:00Z", "2026-06-01T13:00:00Z"),
            span("2026-06-01T07:00:00Z", "2026-06-01T09:00:00Z"),
        ]);
        expect(iso(free)).toEqual([
            ["2026-06-01T09:00:00.000Z", "2026-06-01T12:00:00.000Z"],
            ["2026-06-01T13:00:00.000Z", "2026-06-01T18:00:00.000Z"],
        ]);
    });

    it("intersects working hours with opening hours", () => {
        const working = [span("2026-06-01T07:00:00Z", "2026-06-01T10:00:00Z"), span("2026-06-01T16:00:00Z", "2026-06-01T20:00:00Z")];
        expect(iso(intersectIntervals(working, day))).toEqual([
            ["2026-06-01T08:00:00.000Z", "2026-06-01T10:00:00.000Z"],
            ["2026-06-01T16:00:00.000Z", "2026-06-01T18:00:00.000Z"],
        ]);
    });

    it("checks coverage", () => {
        expect(isCovered(span("2026-06-01T09:00:00Z", "2026-06-01T10:00:00Z"), day)).toBe(true);
        expect(isCovered(span("2026-06-01T17:30:00Z", "2026-06-01T18:30:00Z"), day)).toBe(false);
    });
});

describe("addLocalDays / localDayInterval", () => {
    it("moves across month and year ends", () => {
        expect(addLocalDays("2026-12-31", 1)).toBe("2027-01-01");
        expect(addLocalDays("2026-03-01", -1)).toBe("2026-02-28");
    });

    it("spans 23 hours on the spring-forward day in Zurich", () => {
        const day = localDayInterval("2026-03-29", "Europe/Zurich");
        expect(day.start.toISOString()).toBe("2026-03-28T23:00:00.000Z");
        expect(day.end.toISOString()).toBe("2026-03-29T22:00:00.000Z");
    });
});
