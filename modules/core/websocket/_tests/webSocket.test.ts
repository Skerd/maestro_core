import net from "net";
import WebSocket, {ClientOptions} from "ws";
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";

const ids = vi.hoisted(() => ({
    company: "650000000000000000000001",
    alice: "650000000000000000000a01",
    bob: "650000000000000000000b01",
    carol: "650000000000000000000c01",
    late: "650000000000000000000d01",
    visitor: "650000000000000000000e01",
    agent: "650000000000000000000f01",
    teamChannel: "6500000000000000000aaa01",
    visitorChannel: "6500000000000000000bbb01",
}));

const state = vi.hoisted(() => ({
    /** token → user claims */
    tokens: {} as Record<string, {id: string; username: string; company: {_id: string}; sessionId: string; exp?: number}>,
    admins: new Set<string>(),
    channels: {} as Record<string, string[]>,
    authDelayMs: 0,
    sessionExpiresAt: undefined as Date | undefined,
}));

vi.mock("@coreModule/environment", () => ({
    MACHINE_TO_MACHINE_SECRET: "m2m-secret",
    WEBSOCKET: {PORT: 0},
}));
vi.mock("@coreModule/utilities/security/jwtValidator", () => ({
    validateJWTToken: (token: string) => {
        const user = state.tokens[token];
        if (!user) throw new Error("invalid token");
        return user;
    },
}));
vi.mock("@coreModule/utilities/security/sessionValidator", () => ({
    getTokenSessionId: (user: {sessionId: string}) => user.sessionId,
    validateActiveUserSession: async () => {
        await new Promise((resolve) => setTimeout(resolve, state.authDelayMs));
        return {expiresAt: state.sessionExpiresAt};
    },
}));
vi.mock("@coreModule/domain/publicChat/visitorSession", () => ({
    tryResolveVisitorSession: async ({token}: {token: string}) => token === "visitor-token"
        ? {visitorUser: {_id: ids.visitor}, visitorChannel: {_id: ids.visitorChannel}}
        : null,
}));
vi.mock("@coreModule/database/schemas/channel/channel.service", () => ({
    channelService: {
        findOne: vi.fn(async (query: {_id: {toString(): string}}) => {
            const users = state.channels[query._id.toString()];
            return users ? {users} : null;
        }),
    },
}));
vi.mock("@coreModule/database/schemas/user/user.service", () => ({
    userService: {
        updateById: vi.fn(async () => ({})),
        findByIdOrThrow: async (userId: string) => ({
            getCompanyAccess: async () => ({isAdmin: state.admins.has(userId), permissions: []}),
        }),
    },
}));
vi.mock("@coreModule/database/security/schemaGuard", () => ({
    default: {
        sanitizeFields: (_model: unknown, _fields: unknown, _action: unknown, userCtx: {isAdmin: boolean}) => {
            if (!userCtx.isAdmin) throw new Error("permission denied");
            return {};
        },
    },
}));
vi.mock("@coreModule/database/schemas/performance/serverPerformance/serverPerformance1m", () => ({default: {}}));
vi.mock("@coreModule/domain/messages/applyMessageReceipts", () => ({applyMessageReceipts: vi.fn(async () => {})}));
vi.mock("@coreModule/utilities/serviceMetrics/serviceCounters", () => ({
    webSocketCounter: {
        recordSuccess: vi.fn(),
        recordFailure: vi.fn(),
        getStats: () => ({completedJobs: 0, failedJobs: 0, totalTime: 0}),
    },
}));
vi.mock("@coreModule/utilities/serviceMetrics/wsMessageStore", () => ({getStoredRoomMessages: () => 0}));
vi.mock("@coreModule/utilities/uptime/uptimeKeeper", () => ({uptimeKeeper: {getLastStart: () => 0}}));

import {
    broadcastToRoom,
    getLocalWebSocketServerHealth,
    getWebSocketPresenceStats,
    Room,
    startWebSocketServer,
    stopWebSocketServer,
    sweepConnections,
} from "../webSocket";
import {userService} from "@coreModule/database/schemas/user/user.service";

type Frame = {code: string; payload: any};
type Client = {
    socket: WebSocket;
    frames: Frame[];
    closed: Promise<{code: number; reason: string}>;
};

let port = 0;
const openClients: WebSocket[] = [];

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once("error", reject);
        probe.listen(0, () => {
            const {port} = probe.address() as net.AddressInfo;
            probe.close(() => resolve(port));
        });
    });
}

function socketFor(path: string, options?: ClientOptions): Client {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, options);
    openClients.push(socket);
    const frames: Frame[] = [];
    socket.on("message", (data) => {
        try {
            frames.push(JSON.parse(data.toString()));
        }
        catch {
            // The plain-text greeting.
        }
    });
    socket.on("error", () => {});
    const closed = new Promise<{code: number; reason: string}>((resolve) => {
        socket.on("close", (code, reason) => resolve({code, reason: reason.toString()}));
    });
    return {socket, frames, closed};
}

async function connect(token: string, options?: ClientOptions): Promise<Client> {
    const client = socketFor(`/${token}/en-US`, options);
    await new Promise<void>((resolve, reject) => {
        client.socket.once("open", () => resolve());
        client.socket.once("error", reject);
    });
    return client;
}

function send(client: Client, code: string, payload: unknown): void {
    client.socket.send(JSON.stringify({code, payload}));
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 1000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = read();
        if (value !== undefined) return value;
        if (Date.now() > deadline) throw new Error("timed out waiting");
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

function frame(client: Client, code: string): Promise<Frame> {
    return waitFor(() => client.frames.find((entry) => entry.code === code));
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function addUser(token: string, id: string, username: string, sessionId = `session-${token}`, exp?: number): void {
    state.tokens[token] = {id, username, company: {_id: ids.company}, sessionId, exp};
}

describe("websocket server", () => {
    beforeAll(async () => {
        port = await freePort();
        await startWebSocketServer(port);
    });

    afterAll(async () => {
        await stopWebSocketServer();
    });

    beforeEach(() => {
        state.tokens = {};
        state.admins.clear();
        state.channels = {
            [ids.teamChannel]: [ids.alice, ids.bob],
            [ids.visitorChannel]: [ids.visitor, ids.agent],
        };
        state.authDelayMs = 0;
        state.sessionExpiresAt = undefined;
        addUser("token-alice", ids.alice, "alice");
        addUser("token-bob", ids.bob, "bob");
        addUser("token-carol", ids.carol, "carol");
        addUser("token-agent", ids.agent, "agent");
        vi.mocked(userService.updateById).mockClear();
    });

    afterEach(async () => {
        for (const socket of openClients.splice(0)) socket.terminate();
        await pause(20);
    });

    it("applies a JOIN the client sends the moment the socket opens", async () => {
        state.authDelayMs = 30;
        const client = socketFor("/token-alice/en-US");
        client.socket.on("open", () => send(client, "JOIN_ROOM", ["bookings"]));

        const reply = await frame(client, "JOIN_ROOM");

        expect(reply.payload.joined).toEqual(["bookings"]);
        const room = getWebSocketPresenceStats().rooms.find((entry) => entry.id === "bookings");
        expect(room?.users).toEqual([{id: ids.alice, username: "alice", instances: 1}]);
    });

    it("never registers a client that leaves while it is being authenticated", async () => {
        state.authDelayMs = 40;
        addUser("token-late", ids.late, "late");
        const client = socketFor("/token-late/en-US");
        await pause(10);
        client.socket.terminate();
        await pause(80);

        expect(getWebSocketPresenceStats().rooms.flatMap((room) => room.users).some((user) => user.id === ids.late)).toBe(false);
        expect(vi.mocked(userService.updateById)).not.toHaveBeenCalled();
    });

    it("closes a rejected token with 1008", async () => {
        const client = socketFor("/not-a-token/en-US");
        expect(await client.closed).toEqual({code: 1008, reason: "Invalid websocket token"});
    });

    it("lets only users with server-performance access into the server rooms", async () => {
        state.admins.add(ids.bob);
        const alice = await connect("token-alice");
        const bob = await connect("token-bob");

        send(alice, "JOIN_ROOM", [Room.SERVER_HEALTH]);
        send(bob, "JOIN_ROOM", [Room.SERVER_HEALTH]);
        expect((await frame(alice, "JOIN_ROOM")).payload).toMatchObject({failed: [Room.SERVER_HEALTH], joined: []});
        expect((await frame(bob, "JOIN_ROOM")).payload).toMatchObject({failed: [], joined: [Room.SERVER_HEALTH]});

        broadcastToRoom(Room.SERVER_HEALTH, "ServerHealthUpdater", {status: "ok"});
        expect((await frame(bob, "ServerHealthUpdater")).payload).toEqual({status: "ok"});
        await pause(30);
        expect(alice.frames.some((entry) => entry.code === "ServerHealthUpdater")).toBe(false);
    });

    it("refuses malformed room ids and caps the rooms of a connection", async () => {
        const client = await connect("token-alice");
        const rooms = Array.from({length: 33}, (_, index) => `room${index}`);

        send(client, "JOIN_ROOM", ["bad room", 5, ...rooms]);
        const reply = await frame(client, "JOIN_ROOM");

        expect(reply.payload.joined).toEqual(rooms.slice(0, 32));
        expect(reply.payload.failed).toEqual(["bad room", "5", "room32"]);
    });

    it("attributes typing to the sender's own socket and only for channel members", async () => {
        const alice = await connect("token-alice");
        const bob = await connect("token-bob");
        const carol = await connect("token-carol");

        send(alice, "TYPING_START", {channelId: ids.teamChannel, userId: ids.bob});
        expect((await frame(bob, "TYPING_START")).payload).toEqual({channelId: ids.teamChannel, userId: ids.alice, typing: true});

        send(carol, "TYPING_STOP", {channelId: ids.teamChannel});
        await pause(40);
        expect(bob.frames.some((entry) => entry.code === "TYPING_STOP")).toBe(false);
        expect(alice.frames.some((entry) => entry.code === "TYPING_START")).toBe(false);
    });

    it("confines a visitor to typing in its own chat", async () => {
        const agent = await connect("token-agent");
        const bob = await connect("token-bob");
        const visitor = await connect("visitor-token");

        send(visitor, "JOIN_ROOM", ["bookings"]);
        send(visitor, "TYPING_START", {channelId: ids.teamChannel});

        expect((await frame(agent, "TYPING_START")).payload).toEqual({channelId: ids.visitorChannel, userId: ids.visitor, typing: true});
        await pause(30);
        expect(bob.frames).toEqual([]);
        expect(visitor.frames).toEqual([]);
    });

    it("ignores unknown codes and keeps the connection open", async () => {
        const client = await connect("token-alice");

        send(client, "SOMETHING_NEW", {});
        send(client, "JOIN_ROOM", ["bookings"]);

        expect((await frame(client, "JOIN_ROOM")).payload.joined).toEqual(["bookings"]);
        expect(client.socket.readyState).toBe(WebSocket.OPEN);
    });

    it("survives a malformed frame, closing only that connection", async () => {
        const client = await connect("token-alice");
        // A masked frame with the reserved opcode 0x3.
        (client.socket as any)._socket.write(Buffer.from([0x83, 0x80, 1, 2, 3, 4]));

        expect((await client.closed).code).toBe(1002);
        const next = await connect("token-bob");
        expect(next.socket.readyState).toBe(WebSocket.OPEN);
    });

    it("closes a client frame over the size limit with 1009", async () => {
        const client = await connect("token-alice");
        client.socket.send("x".repeat(70 * 1024));
        expect((await client.closed).code).toBe(1009);
    });

    it("drops frames beyond the rate limit", async () => {
        const client = await connect("token-alice");
        for (let index = 0; index < 105; index++) send(client, "LEAVE_ROOM", ["bookings"]);

        await waitFor(() => client.frames.length >= 100 ? true : undefined);
        await pause(40);
        expect(client.frames).toHaveLength(100);
    });

    it("forwards machine pushes and closes the revoked session only", async () => {
        addUser("token-alice-2", ids.alice, "alice", "session-two");
        const machine = await connect("m2m-secret");
        const first = await connect("token-alice");
        const second = await connect("token-alice-2");

        machine.socket.send(JSON.stringify({code: "NEW_MESSAGE", payload: {messageId: "m1"}, userIds: [ids.alice]}));
        expect((await frame(first, "NEW_MESSAGE")).payload).toEqual({messageId: "m1"});
        expect((await frame(second, "NEW_MESSAGE")).payload).toEqual({messageId: "m1"});

        machine.socket.send(JSON.stringify({code: "SESSION_REVOKED", payload: {sessionId: "session-token-alice"}, userIds: [ids.alice]}));

        expect((await frame(first, "SESSION_REVOKED")).payload).toEqual({sessionId: "session-token-alice"});
        expect(await first.closed).toEqual({code: 1008, reason: "Session revoked"});
        expect((await frame(second, "SESSION_REVOKED")).payload).toEqual({sessionId: "session-token-alice"});
        expect(second.socket.readyState).toBe(WebSocket.OPEN);
    });

    it("closes a connection once its token expires", async () => {
        addUser("token-expiring", ids.alice, "alice", "session-expiring", Math.floor(Date.now() / 1000) + 60);
        const client = await connect("token-expiring");

        sweepConnections(Date.now() + 61_000);

        expect(await client.closed).toEqual({code: 1008, reason: "Websocket session expired"});
    });

    it("terminates a peer that stops answering pings, and keeps one that answers", async () => {
        const silent = await connect("token-alice", {autoPong: false});
        const healthy = await connect("token-bob");

        sweepConnections();
        await pause(40);
        sweepConnections();

        expect((await silent.closed).code).toBe(1006);
        expect(healthy.socket.readyState).toBe(WebSocket.OPEN);
    });

    it("reports health and presence for this process", async () => {
        await connect("token-alice");
        await connect("token-alice");

        const health = getLocalWebSocketServerHealth();
        expect(health.connected).toBe(true);
        expect(health).not.toHaveProperty("circuitBreaker");
        expect(getWebSocketPresenceStats().totalConnections).toBeGreaterThanOrEqual(2);
    });

    it("closes every connection with 1001 when the server stops", async () => {
        const client = await connect("token-alice");

        await stopWebSocketServer();

        expect((await client.closed).code).toBe(1001);
        expect(getLocalWebSocketServerHealth().connected).toBe(false);
    });
});
