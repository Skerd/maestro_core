import {describe, expect, it} from "vitest";
import {computeRetryDelayMs, resolveRunAttempt, shouldRetry} from "../engine/retryEngine";

describe("retryEngine", () => {
    it("respects max retries", () => {
        expect(shouldRetry(1, 3)).toBe(true);
        expect(shouldRetry(3, 3)).toBe(true);
        expect(shouldRetry(4, 3)).toBe(false);
        expect(shouldRetry(1, 0)).toBe(false);
    });

    it("computes exponential backoff", () => {
        const delay = computeRetryDelayMs({retryDelaySeconds: 10}, 3, "exponential");
        expect(delay).toBe(40_000);
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
        expect(resolveRunAttempt(
            {status: "failed", attempt: 4, nextRetryAt: new Date("2026-01-01T00:00:00.000Z")},
            {manual: true},
        )).toBe(1);
        expect(resolveRunAttempt(null, {attempt: 5})).toBe(5);
    });
});
