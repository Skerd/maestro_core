import {beforeEach, describe, expect, it, vi} from "vitest";

const incr = vi.fn();
const expire = vi.fn();
const ttl = vi.fn();
const decr = vi.fn();
const isRedisConnected = vi.fn();

vi.mock("@coreModule/connections/connectToRedis", () => ({
    isRedisConnected: () => isRedisConnected(),
    getRedisClient: () => ({incr, expire, ttl, decr}),
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
        incr.mockReset();
        expire.mockReset();
        ttl.mockReset();
        decr.mockReset();
        isRedisConnected.mockReset();
    });

    it("fails closed on public auth when Redis is down", async () => {
        isRedisConnected.mockReturnValue(false);
        const next = vi.fn();
        await rateLimiter({windowMs: 60000, max: 10, failClosed: true})(
            mockReq() as never,
            mockRes() as never,
            next,
        );
        expect(next).toHaveBeenCalledTimes(1);
        expect(next.mock.calls[0]![0]).toBeInstanceOf(Error);
    });

    it("fails open for private CRUD when Redis is down", async () => {
        isRedisConnected.mockReturnValue(false);
        const next = vi.fn();
        await rateLimiter({windowMs: 60000, max: 60})(
            mockReq() as never,
            mockRes() as never,
            next,
        );
        expect(next).toHaveBeenCalledWith();
    });

    it("increments atomically and expires only on the first hit", async () => {
        isRedisConnected.mockReturnValue(true);
        incr.mockResolvedValue(1);
        expire.mockResolvedValue(1);
        ttl.mockResolvedValue(60);
        const next = vi.fn();
        await rateLimiter({windowMs: 60000, max: 10})(
            mockReq() as never,
            mockRes() as never,
            next,
        );
        expect(incr).toHaveBeenCalledTimes(1);
        expect(expire).toHaveBeenCalledTimes(1);
        expect(next).toHaveBeenCalledWith();
    });

    it("does not reset expire on subsequent hits", async () => {
        isRedisConnected.mockReturnValue(true);
        incr.mockResolvedValue(2);
        ttl.mockResolvedValue(40);
        const next = vi.fn();
        await rateLimiter({windowMs: 60000, max: 10})(
            mockReq() as never,
            mockRes() as never,
            next,
        );
        expect(expire).not.toHaveBeenCalled();
        expect(next).toHaveBeenCalledWith();
    });

    it("rejects when the counter exceeds max", async () => {
        isRedisConnected.mockReturnValue(true);
        incr.mockResolvedValue(11);
        ttl.mockResolvedValue(20);
        const next = vi.fn();
        await rateLimiter({windowMs: 60000, max: 10})(
            mockReq() as never,
            mockRes() as never,
            next,
        );
        expect(next.mock.calls[0]![0]).toBeInstanceOf(Error);
    });
});
