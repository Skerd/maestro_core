import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

const state = vi.hoisted(() => ({logLines: [] as string[]}));

const fakeMongoose = vi.hoisted(() => {
    const {EventEmitter: Emitter} = require("events") as typeof import("events");
    const connection = Object.assign(new Emitter(), {readyState: 0, host: "localhost", name: "testDb", db: undefined});
    return {
        set: vi.fn(),
        connect: vi.fn(async () => {
            connection.readyState = 1;
        }),
        disconnect: vi.fn(async () => {
            connection.readyState = 0;
            connection.emit("disconnected");
        }),
        connection,
    };
});

vi.mock("mongoose", () => ({default: fakeMongoose}));
vi.mock("@coreModule/environment", () => ({
    MONGO_DB: {
        PRE_HOST: "mongodb://",
        USER: "app",
        PASSWORD: "s3cret-pass",
        HOST: "localhost",
        PORT: "27017",
        DB_NAME: "testDb",
        PARAMS: "?tls=true",
        ROOT_CA_CERT_PATH: "/certs/ca.pem",
        TLS_CERTIFICATE_KEY_FILE_PATH: "/certs/client.pem",
        CONNECTION_TIMER: 1000,
    },
}));
vi.mock("@coreModule/loggers/serverLog", () => {
    const logger: Record<string, unknown> = {};
    for (const level of ["start", "finish", "debug", "info", "warn", "err", "fail"]) {
        logger[level] = (...args: unknown[]) => state.logLines.push(args.map(String).join(" "));
    }
    return {getLogger: () => logger};
});
vi.mock("@coreModule/utilities/uptime/uptimeKeeper", () => ({
    uptimeKeeper: {markStart: vi.fn(async () => {}), getLastStart: vi.fn(() => 0)},
}));
vi.mock("@initializer", () => ({initializeMongoDatabase: vi.fn(async () => {})}));

const EXPECTED_URI = "mongodb://app:s3cret-pass@localhost:27017/testDb?tls=true&tlsCAFile=/certs/ca.pem&tlsCertificateKeyFile=/certs/client.pem";

describe("connectToMongoDb", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.resetModules();
        state.logLines.length = 0;
        fakeMongoose.connect.mockClear();
        fakeMongoose.disconnect.mockClear();
        fakeMongoose.connection.removeAllListeners();
        fakeMongoose.connection.readyState = 0;
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("connects with the TLS files and never logs the password", async () => {
        const {connectToMongoDb} = await import("../connectToMongoDb");
        await connectToMongoDb();

        expect(fakeMongoose.connect).toHaveBeenCalledWith(EXPECTED_URI);
        expect(state.logLines.join("\n")).not.toContain("s3cret-pass");
    });

    it("retries until the first connection succeeds", async () => {
        fakeMongoose.connect.mockRejectedValueOnce(new Error("ECONNREFUSED"));
        const {connectToMongoDb} = await import("../connectToMongoDb");
        const pending = connectToMongoDb();
        await vi.advanceTimersByTimeAsync(1000);
        await pending;

        expect(fakeMongoose.connect).toHaveBeenCalledTimes(2);
    });

    it("registers the connection handlers once, however often it is called", async () => {
        const {connectToMongoDb} = await import("../connectToMongoDb");
        await connectToMongoDb();
        await connectToMongoDb();

        expect(fakeMongoose.connection.listenerCount("disconnected")).toBe(1);
    });

    it("leaves reconnection to the driver and does not reconnect after a deliberate disconnect", async () => {
        const {connectToMongoDb, disconnectFromMongoDb} = await import("../connectToMongoDb");
        await connectToMongoDb();
        fakeMongoose.connection.emit("disconnected");
        await disconnectFromMongoDb();
        await vi.advanceTimersByTimeAsync(10_000);

        expect(fakeMongoose.disconnect).toHaveBeenCalledTimes(1);
        expect(fakeMongoose.connect).toHaveBeenCalledTimes(1);
    });

    it("reports health without a circuit breaker", async () => {
        const {connectToMongoDb, getMongoDbHealth} = await import("../connectToMongoDb");
        await connectToMongoDb();
        const health = await getMongoDbHealth();

        expect(health).toMatchObject({connected: true, readyState: 1, host: "localhost", name: "testDb"});
        expect(health).not.toHaveProperty("circuitBreaker");
    });
});
