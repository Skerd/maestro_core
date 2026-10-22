import {describe, expect, it} from "vitest";
import {computeRetryDelayMs, resolveRunAttempt, shouldRetry} from "../engine/retryEngine";
import {selectRunCount} from "../engine/missedRunPolicy";

describe("retryEngine", () => {
    it("respects max retries", () => {
        expect(shouldRetry(1, 3)).toBe(true);
        expect(shouldRetry(3, 3)).toBe(true);
        expect(shouldRetry(4, 3)).toBe(false);
        expect(shouldRetry(1, 0)).toBe(false);
    });

    it("backs off exponentially with up to one base delay of jitter", () => {
        const delay = computeRetryDelayMs({retryDelaySeconds: 10}, 3);
        expect(delay).toBeGreaterThanOrEqual(40_000);
        expect(delay).toBeLessThan(50_000);
        expect(computeRetryDelayMs({retryDelaySeconds: 86_400}, 5)).toBe(86_400_000);
    });

    it("starts at attempt 1 unless the last run queued a retry", () => {
        expect(resolveRunAttempt(null)).toBe(1);
        expect(resolveRunAttempt({status: "success", attempt: 2})).toBe(1);
        expect(resolveRunAttempt({status: "failed", attempt: 2})).toBe(1);
        expect(resolveRunAttempt({
            status: "failed",
            attempt: 2,
            nextRetryAt: new Date("2026-01-01T00:00:00.000Z"),
        })).toBe(3);
        expect(resolveRunAttempt({
            status: "timeout",
            attempt: 1,
            nextRetryAt: new Date("2026-01-01T00:00:00.000Z"),
        })).toBe(2);
    });
});

describe("missedRunPolicy", () => {
    it("always runs a single due occurrence", () => {
        for (const policy of ["skip", "run_once", "catch_up", undefined] as const) {
            expect(selectRunCount(policy, 1)).toBe(1);
            expect(selectRunCount(policy, 0)).toBe(0);
        }
    });

    it("applies the policy to a backlog", () => {
        expect(selectRunCount("skip", 4)).toBe(0);
        expect(selectRunCount(undefined, 4)).toBe(0);
        expect(selectRunCount("run_once", 4)).toBe(1);
        expect(selectRunCount("catch_up", 4)).toBe(4);
    });
});
