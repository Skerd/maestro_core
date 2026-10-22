import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

const state = vi.hoisted(() => ({sockets: [] as any[]}));

vi.mock("ws", () => {
    const {EventEmitter} = require("events") as typeof import("events");
    class FakeWebSocket extends EventEmitter {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;
        readyState = FakeWebSocket.CONNECTING;
        send = vi.fn((_data: string, callback?: (error?: Error) => void) => callback?.());
        ping = vi.fn();
        constructor(public url: string) {
            super();
            state.sockets.push(this);
        }
        open() {
            this.readyState = FakeWebSocket.OPEN;
            this.emit("open");
        }
        close() {
            this.shut(1000);
        }
        terminate() {
            this.shut(1006);
        }
        private shut(code: number) {
            if (this.readyState === FakeWebSocket.CLOSED) return;
            this.readyState = FakeWebSocket.CLOSED;
            this.emit("close", code, Buffer.from(""));
        }
    }
    return {WebSocket: FakeWebSocket};
});
vi.mock("@coreModule/environment", () => ({
    MACHINE_TO_MACHINE_SECRET: "m2m-secret",
    WEBSOCKET: {HOST: "ws-host", PORT: 82, RETRY_TIMER: 1000, KEEP_ALIVE_INTERVAL: 1000},
}));
vi.mock("@coreModule/utilities/uptime/uptimeKeeper", () => ({
    uptimeKeeper: {markStart: vi.fn(async () => {}), getLastStart: vi.fn(() => 0)},
}));

type WsModule = typeof import("../connectToWebSocketServer");

async function connected(): Promise<{ws: WsModule; socket: any}> {
    const ws = await import("../connectToWebSocketServer");
    await ws.connectToWebSocketServer();
    const socket = state.sockets[state.sockets.length - 1];
    socket.open();
    await vi.advanceTimersByTimeAsync(0);
    return {ws, socket};
}

describe("connectToWebSocketServer", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.resetModules();
        state.sockets.length = 0;
        global.ServerName = "TestServer";
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("connects with the machine secret in the path but keeps it out of health", async () => {
        const {ws, socket} = await connected();

        expect(socket.url).toBe("ws://ws-host:82/m2m-secret/TestServer");
        const health = ws.getWebSocketHealth();
        expect(health.connected).toBe(true);
        expect(health.url).toBe("ws://ws-host:82");
    });

    it("sends JSON once connected and drops messages before that", async () => {
        const ws = await import("../connectToWebSocketServer");
        ws.pushWebsocketMessage({code: "EARLY", userIds: [], payload: null});
        await ws.connectToWebSocketServer();
        const socket = state.sockets[0];
        socket.open();
        await vi.advanceTimersByTimeAsync(0);

        ws.pushWebsocketMessage({code: "HELLO", userIds: ["u1"], payload: 1});
        await vi.advanceTimersByTimeAsync(0);

        expect(socket.send).toHaveBeenCalledTimes(1);
        expect(JSON.parse(socket.send.mock.calls[0][0])).toEqual({code: "HELLO", userIds: ["u1"], payload: 1});
    });

    it("reconnects after the server closes the connection", async () => {
        const {ws, socket} = await connected();
        socket.close();
        expect(ws.getWebSocketHealth().connected).toBe(false);

        await vi.advanceTimersByTimeAsync(1000);
        expect(state.sockets).toHaveLength(2);
        state.sockets[1].open();
        await vi.advanceTimersByTimeAsync(0);
        expect(ws.getWebSocketHealth().connected).toBe(true);
    });

    it("terminates a connection whose server stopped answering pings", async () => {
        const {socket} = await connected();
        const terminate = vi.spyOn(socket, "terminate");

        await vi.advanceTimersByTimeAsync(3000);
        expect(socket.ping).toHaveBeenCalled();
        expect(terminate).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1000);
        expect(terminate).toHaveBeenCalledTimes(1);
    });

    it("keeps a connection that answers pings", async () => {
        const {socket} = await connected();
        const terminate = vi.spyOn(socket, "terminate");
        for (let i = 0; i < 10; i++) {
            await vi.advanceTimersByTimeAsync(1000);
            socket.emit("pong");
        }

        expect(terminate).not.toHaveBeenCalled();
    });

    it("does not reconnect after disconnectFromWebSocketServer", async () => {
        const {ws} = await connected();
        await ws.disconnectFromWebSocketServer();
        await vi.advanceTimersByTimeAsync(5000);

        expect(state.sockets).toHaveLength(1);
    });

    it("opens the circuit after repeated send failures and then stops sending", async () => {
        const {ws, socket} = await connected();
        socket.send.mockImplementation((_data: string, callback: (error?: Error) => void) => callback(new Error("EPIPE")));

        for (let i = 0; i < 6; i++) {
            ws.pushWebsocketMessage({code: "X", userIds: [], payload: null});
            await vi.advanceTimersByTimeAsync(0);
        }
        expect(socket.send).toHaveBeenCalledTimes(5);
    });
});
