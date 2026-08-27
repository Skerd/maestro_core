import {describe, expect, it} from "vitest";
import {computeNextRunAt, getNextRuns} from "../scheduling/nextRunCalculator";

describe("nextRunCalculator", () => {
    it("computes cron next run", () => {
        const from = new Date("2026-01-01T00:00:00.000Z");
        const next = computeNextRunAt(
            {cronExpression: "0 0 * * * *"},
            from,
        );
        expect(next?.toISOString()).toBe("2026-01-01T01:00:00.000Z");
    });

    it("returns multiple preview runs", () => {
        const from = new Date("2026-01-01T00:00:00.000Z");
        const runs = getNextRuns(
            {cronExpression: "0 0 * * * *"},
            3,
            from,
        );
        expect(runs.map(d => d.toISOString())).toEqual([
            "2026-01-01T01:00:00.000Z",
            "2026-01-01T02:00:00.000Z",
            "2026-01-01T03:00:00.000Z",
        ]);
    });
});
