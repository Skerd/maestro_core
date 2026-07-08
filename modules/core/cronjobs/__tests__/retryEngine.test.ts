import {describe, expect, it} from "vitest";
import {computeRetryDelayMs, shouldRetry} from "../engine/retryEngine";

describe("retryEngine", () => {
    it("respects max retries", () => {
        expect(shouldRetry(1, 3)).toBe(true);
        expect(shouldRetry(4, 3)).toBe(false);
    });

    it("computes exponential backoff", () => {
        const delay = computeRetryDelayMs({retryDelaySeconds: 10}, 3, "exponential");
        expect(delay).toBe(40_000);
    });
});
