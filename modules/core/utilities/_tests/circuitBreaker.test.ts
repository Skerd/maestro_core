import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {CircuitBreaker, CircuitState} from "../circuitBreaker";

const silentLogger = {info: vi.fn(), warn: vi.fn(), debug: vi.fn(), err: vi.fn()} as any;

function breaker(overrides: Record<string, number> = {}) {
    return new CircuitBreaker({
        name: "Test",
        failureThreshold: 3,
        failureWindow: 60_000,
        resetTimeout: 30_000,
        successThreshold: 2,
        logger: silentLogger,
        ...overrides,
    });
}

const ok = () => Promise.resolve("ok");
const boom = () => Promise.reject(new Error("boom"));

async function failTimes(cb: CircuitBreaker, n: number) {
    for (let i = 0; i < n; i++) {
        await expect(cb.execute(boom)).rejects.toThrow("boom");
    }
}

describe("CircuitBreaker", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-10-22T10:00:00Z"));
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("opens after the threshold of failures inside one window and then fails fast", async () => {
        const cb = breaker();
        await failTimes(cb, 3);

        expect(cb.getStats().state).toBe(CircuitState.OPEN);
        const fn = vi.fn(ok);
        await expect(cb.execute(fn)).rejects.toThrow("Circuit breaker Test is OPEN");
        expect(fn).not.toHaveBeenCalled();
    });

    it("does not open when failures are spread across windows, even with successes in between", async () => {
        const cb = breaker();
        for (let i = 0; i < 6; i++) {
            await expect(cb.execute(boom)).rejects.toThrow();
            vi.advanceTimersByTime(20_000);
            await cb.execute(ok);
            vi.advanceTimersByTime(20_000);
        }

        expect(cb.getStats().state).toBe(CircuitState.CLOSED);
    });

    it("counts a call that exceeds callTimeout as a failure", async () => {
        const cb = breaker({callTimeout: 1_000, failureThreshold: 1});
        const hung = cb.execute(() => new Promise(() => {}));
        const assertion = expect(hung).rejects.toThrow("call timed out after 1000 ms");
        await vi.advanceTimersByTimeAsync(1_000);
        await assertion;

        expect(cb.getStats().state).toBe(CircuitState.OPEN);
    });

    it("moves to HALF_OPEN after resetTimeout and closes after enough trial successes", async () => {
        const cb = breaker();
        await failTimes(cb, 3);
        vi.advanceTimersByTime(30_000);

        await cb.execute(ok);
        expect(cb.getStats().state).toBe(CircuitState.HALF_OPEN);
        await cb.execute(ok);
        expect(cb.getStats().state).toBe(CircuitState.CLOSED);
        expect(cb.getStats().failures).toBe(0);
    });

    it("re-opens when the HALF_OPEN trial call fails", async () => {
        const cb = breaker();
        await failTimes(cb, 3);
        vi.advanceTimersByTime(30_000);

        await expect(cb.execute(boom)).rejects.toThrow("boom");
        expect(cb.getStats().state).toBe(CircuitState.OPEN);
    });

    it("lets only one HALF_OPEN trial call through at a time", async () => {
        const cb = breaker();
        await failTimes(cb, 3);
        vi.advanceTimersByTime(30_000);

        let release!: (v: string) => void;
        const trial = cb.execute(() => new Promise<string>((r) => { release = r; }));
        const second = vi.fn(ok);
        await expect(cb.execute(second)).rejects.toThrow("is OPEN");
        expect(second).not.toHaveBeenCalled();

        release("done");
        await expect(trial).resolves.toBe("done");
        await expect(cb.execute(ok)).resolves.toBe("ok");
    });

    it("isOpen() reports without changing state", async () => {
        const cb = breaker();
        await failTimes(cb, 3);
        expect(cb.isOpen()).toBe(true);

        vi.advanceTimersByTime(30_000);
        expect(cb.isOpen()).toBe(false);
        expect(cb.getStats().state).toBe(CircuitState.OPEN);
    });

    it("reset() closes the circuit and clears the counters", async () => {
        const cb = breaker();
        await failTimes(cb, 3);
        cb.reset();

        expect(cb.getStats()).toMatchObject({state: CircuitState.CLOSED, failures: 0, successes: 0});
        await expect(cb.execute(ok)).resolves.toBe("ok");
    });
});
