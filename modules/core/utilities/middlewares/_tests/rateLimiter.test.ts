import {beforeEach, describe, expect, it, vi} from "vitest";

const redisIncrWithExpiry = vi.fn();
const decr = vi.fn();

vi.mock("@coreModule/connections/connectToRedis", () => ({
    redisIncrWithExpiry: (key: string, ttl: number) => redisIncrWithExpiry(key, ttl),
    executeWithCircuitBreaker: (op: () => Promise<unknown>) => op(),
    getRedisClient: () => ({decr}),
}));
vi.mock("@coreModule/environment", () => ({
    CONSTANTS: {DEFAULT_LANGUAGE: "en-US"},
}));

import {rateLimiter} from "../rateLimiter";

function mockReq(overrides: Record<string, unknown> = {}) {
    return {
        method: "POST",
        baseUrl: "/api/user/signUp",
        path: "/",
        header: (name: string) => (name === "language" ? "en-US" : undefined),
        body: {requestIp: "10.0.0.1"},
        ip: "10.0.0.1",
        socket: {remoteAddress: "10.0.0.1"},
        ...overrides,
    };
}

function mockRes() {
    const headers: Record<string, string> = {};
    return {
        headers,
        statusCode: 200,
        setHeader: (k: string, v: string) => {
            headers[k] = v;
        },
        send: vi.fn(),
    };
}

describe("rateLimiter", () => {
    beforeEach(() => {
        redisIncrWithExpiry.mockReset();
        decr.mockReset();
    });

    it("fails closed on public auth when Redis is unavailable", async () => {
        redisIncrWithExpiry.mockResolvedValue(null);
        const next = vi.fn();
        await rateLimiter({windowMs: 60000, max: 10, failClosed: true})(
            mockReq() as never,
            mockRes() as never,
            next,
        );
        expect(next).toHaveBeenCalledTimes(1);
        expect(next.mock.calls[0]![0]).toBeInstanceOf(Error);
    });

    it("fails open for private CRUD when Redis is unavailable", async () => {
        redisIncrWithExpiry.mockResolvedValue(null);
        const next = vi.fn();
        await rateLimiter({windowMs: 60000, max: 60})(
            mockReq() as never,
            mockRes() as never,
            next,
        );
        expect(next).toHaveBeenCalledWith();
    });

    it("counts the request under a per-IP key with the window as expiry", async () => {
        redisIncrWithExpiry.mockResolvedValue({count: 1, ttlSeconds: 60});
        const next = vi.fn();
        const res = mockRes();
        await rateLimiter({windowMs: 60000, max: 10})(
            mockReq() as never,
            res as never,
            next,
        );
        expect(redisIncrWithExpiry).toHaveBeenCalledWith("rate_limit:POST[:api:user:signUp]:ip:10.0.0.1", 60);
        expect(res.headers["X-RateLimit-Remaining"]).toBe("9");
        expect(next).toHaveBeenCalledWith();
    });

    it("rejects when the counter exceeds max", async () => {
        redisIncrWithExpiry.mockResolvedValue({count: 11, ttlSeconds: 20});
        const next = vi.fn();
        await rateLimiter({windowMs: 60000, max: 10})(
            mockReq() as never,
            mockRes() as never,
            next,
        );
        expect(next.mock.calls[0]![0]).toBeInstanceOf(Error);
    });

    it("gives the hit back when successful requests are skipped", async () => {
        redisIncrWithExpiry.mockResolvedValue({count: 3, ttlSeconds: 50});
        decr.mockResolvedValue(2);
        const res = mockRes();
        await rateLimiter({windowMs: 60000, max: 10, skipSuccessfulRequests: true})(
            mockReq() as never,
            res as never,
            vi.fn() as never,
        );
        res.send("ok");
        expect(decr).toHaveBeenCalledWith("rate_limit:POST[:api:user:signUp]:ip:10.0.0.1");
    });
});
