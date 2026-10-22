import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

const calls: string[] = [];
const step = (name: string) => vi.fn(async () => {
    calls.push(name);
});
const disconnectFromWebSocketServer = step("WebSocket");
const disconnectFromKafka = step("Kafka");
const disconnectFromRedis = step("Redis");
const disconnectFromMongoDb = step("MongoDB");

vi.mock("@coreModule/connections/connectToWebSocketServer", () => ({disconnectFromWebSocketServer: () => disconnectFromWebSocketServer()}));
vi.mock("@coreModule/connections/connectToKafka", () => ({disconnectFromKafka: () => disconnectFromKafka()}));
vi.mock("@coreModule/connections/connectToRedis", () => ({disconnectFromRedis: () => disconnectFromRedis()}));
vi.mock("@coreModule/connections/connectToMongoDb", () => ({disconnectFromMongoDb: () => disconnectFromMongoDb()}));

import {closeConnections} from "../closeConnections";

describe("closeConnections", () => {
    beforeEach(() => {
        calls.length = 0;
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("closes the WebSocket client, Kafka, Redis and MongoDB in that order", async () => {
        await closeConnections();

        expect(calls).toEqual(["WebSocket", "Kafka", "Redis", "MongoDB"]);
    });

    it("keeps closing the rest when one connection fails", async () => {
        disconnectFromKafka.mockRejectedValueOnce(new Error("broker gone"));

        await closeConnections();

        expect(calls).toEqual(["WebSocket", "Redis", "MongoDB"]);
    });

    it("moves on when a connection hangs while closing", async () => {
        disconnectFromRedis.mockReturnValueOnce(new Promise(() => {}));

        const pending = closeConnections();
        await vi.advanceTimersByTimeAsync(5_000);
        await pending;

        expect(calls).toEqual(["WebSocket", "Kafka", "MongoDB"]);
    });
});
