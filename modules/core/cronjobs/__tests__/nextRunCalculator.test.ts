import {describe, expect, it} from "vitest";
import {computeNextRunAt, getNextRuns} from "../scheduling/nextRunCalculator";

describe("nextRunCalculator", () => {
    it("computes interval next run", () => {
        const from = new Date("2026-01-01T00:00:00.000Z");
        const next = computeNextRunAt(
            {type: "interval", interval: {value: 5, unit: "minutes"}, timezone: "UTC"},
            from,
        );
        expect(next?.toISOString()).toBe("2026-01-01T00:05:00.000Z");
    });

    it("computes cron next run", () => {
        const from = new Date("2026-01-01T00:00:00.000Z");
        const next = computeNextRunAt(
            {type: "cron", cronExpression: "0 0 * * * *", timezone: "UTC"},
            from,
        );
        expect(next).toBeTruthy();
        expect(next!.getTime()).toBeGreaterThan(from.getTime());
    });

    it("returns multiple preview runs", () => {
        const runs = getNextRuns(
            {type: "interval", interval: {value: 1, unit: "hours"}, timezone: "UTC"},
            3,
            new Date("2026-01-01T00:00:00.000Z"),
        );
        expect(runs).toHaveLength(3);
    });
});
