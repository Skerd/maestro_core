/**
 * WebSocket Server Implementation
 *
 * The realtime server that the panel, the public-website chat widget and the
 * other maestro processes (machine connections) connect to.
 *
 * Connection flow:
 * 1. The client opens `/<token>/<languageCode>` (nginx strips the `/ws` prefix).
 * 2. The token is authenticated during the HTTP upgrade, before the socket
 *    exists, so a frame sent on `open` (sinfonia re-joins its rooms right away)
 *    always finds its handlers in place.
 * 3. A rejected token still completes the handshake and is closed with 1008,
 *    which tells the client not to retry that token.
 *
 * Connection kinds:
 * - user: a panel session. Joins rooms, sends typing indicators and read
 *   receipts, receives pushes. Closed when its token or session expires, or
 *   when the session is revoked.
 * - visitor: a public-website chat visitor, confined to its own chat channel.
 * - machine: another maestro process, authenticated by `MACHINE_TO_MACHINE_SECRET`.
 *   Its frames are pushes, forwarded to the users they name.
 *
 * Rooms are presence groups. Only `serverHealth` and `serverStats` receive
 * broadcasts, and joining them needs the same permission as the server
 * performance REST endpoints.
 *
 * @module websocket/webSocket
 */

import http, {IncomingMessage} from "http";
import os from "os";
import {timingSafeEqual} from "crypto";
import type {Duplex} from "stream";
import {ObjectId} from "mongodb";
import WebSocket, {RawData, WebSocketServer} from "ws";
import {generateRandomString} from "@coreModule/utilities/helpers";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {validateJWTToken} from "@coreModule/utilities/security/jwtValidator";
import {getTokenSessionId, validateActiveUserSession} from "@coreModule/utilities/security/sessionValidator";
import {JWTTokenType} from "armonia/src/modules/core/api/user/public/login/login.form.response.type";
import {MACHINE_TO_MACHINE_SECRET, WEBSOCKET} from "@coreModule/environment";
import {channelService} from "@coreModule/database/schemas/channel/channel.service";
import {userService} from "@coreModule/database/schemas/user/user.service";
import SchemaGuard from "@coreModule/database/security/schemaGuard";
import ServerPerformance1m from "@coreModule/database/schemas/performance/serverPerformance/serverPerformance1m";
import {WebSocketMessageCodes, WebSocketPush} from "armonia/src/modules/core/websocket/types";
import {WebSocketHealth} from "armonia/src/modules/core/api/auxiliary/private/serverHealth/serverHealth.dto";
import {ServerStatsDto} from "armonia/src/modules/core/api/auxiliary/private/serverStats/serverStats.dto";
import {applyMessageReceipts} from "@coreModule/domain/messages/applyMessageReceipts";
import {webSocketCounter} from "@coreModule/utilities/serviceMetrics/serviceCounters";
import {getStoredRoomMessages} from "@coreModule/utilities/serviceMetrics/wsMessageStore";
import {getKnownRoomIds, getRoomDisplayName} from "@coreModule/websocket/roomRegistry";
import {tryResolveVisitorSession, VisitorSession} from "@coreModule/domain/publicChat/visitorSession";
import {uptimeKeeper} from "@coreModule/utilities/uptime/uptimeKeeper";

/** Largest frame a user or visitor may send. A full read-receipt batch (800 ids) is about 22 KB. */
const CLIENT_MAX_PAYLOAD_BYTES = 64 * 1024;

/** Every connection is pinged this often; one that has not answered the previous ping is terminated. */
const HEARTBEAT_INTERVAL_MS = 5000;

/**
 * When a user's last connection closes, the offline transition waits this long.
 * A browser refresh reconnects within it, so the dashboard never sees a
 * transient `users: 0` blip.
 */
const DISCONNECT_GRACE_MS = 5000;

/**
 * Maximum simultaneous sockets one visitor token may hold. A visitor legitimately
 * has one tab open; this bounds a trivial socket-exhaustion attempt.
 */
const MAX_VISITOR_CONNECTIONS = 3;

const MAX_ROOMS_PER_CONNECTION = 32;

/** Frames a user or visitor may send per window; the rest are dropped. */
const MESSAGE_RATE_WINDOW_MS = 10_000;
const MAX_MESSAGES_PER_WINDOW = 100;

/** How long a channel's member list is reused for typing indicators. */
const CHANNEL_MEMBERS_TTL_MS = 10_000;

/** Room ids, e.g. site presence rooms from panel routes. Max 64 chars; camelCase allowed. */
const ROOM_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

/** Rooms the server broadcasts to. Every other room is presence only. */
export enum Room {
    SERVER_HEALTH = "serverHealth",
    SERVER_STATS = "serverStats",
}

const SERVER_PERFORMANCE_ROOMS: ReadonlySet<string> = new Set([Room.SERVER_HEALTH, Room.SERVER_STATS]);

/**
 * Extended WebSocket type with client-specific metadata
 */
type ClientWebSocket = WebSocket & {
    /** Unique connection ID */
    id: string;
    /** User ID (the visitor id for a visitor connection) */
    userId: string;
    username: string;
    languageCode: string;
    /** Cleared by each heartbeat ping, set again by the pong. */
    isAlive: boolean;
    /** Rooms this connection has joined */
    rooms: Set<string>;
    /** Tail of this connection's JOIN/LEAVE queue (see `queueRoomOperation`). */
    roomOperations?: Promise<void>;
    /** Start and count of the current rate-limit window */
    rateWindowStart: number;
    rateWindowCount: number;
    /** The token's company, for user connections */
    companyId?: string;
    /** The token's session, closed on `SESSION_REVOKED` */
    sessionId?: string | null;
    /** Epoch ms at which the heartbeat closes the connection (token or session expiry) */
    expiresAt?: number;
    /** Machine name (for machine-to-machine connections) */
    machineName?: string;
    /** Whether this is a machine-to-machine connection */
    isMachine?: boolean;
    /**
     * Whether this is an anonymous public-website chat visitor. Such a
     * connection is confined to ONE channel: it joins no rooms, receives no
     * system broadcasts, and may only emit typing indicators for its own chat.
     */
    isVisitor?: boolean;
    /** The single channel a visitor connection is allowed to touch. */
    visitorChannelId?: string;
}

/** Who a connection is, resolved during the upgrade. */
type ConnectionIdentity =
    | {kind: "user"; user: JWTTokenType; sessionId: string | null; expiresAt: number; languageCode: string}
    | {kind: "visitor"; session: VisitorSession; languageCode: string}
    | {kind: "machine"; machineName: string}
    | {kind: "rejected"; reason: string};

let httpServer: http.Server | null = null;
let heartbeat: NodeJS.Timeout | null = null;

const clientServer = new WebSocketServer({noServer: true, maxPayload: CLIENT_MAX_PAYLOAD_BYTES});
/** Machine pushes (chat messages, notification batches) can be large and come from a trusted peer, so they keep ws's limit. */
const machineServer = new WebSocketServer({noServer: true});

/**
 * Open sockets per user ID. Supports multiple connections per user (tabs/devices).
 * A user's empty set stays during the disconnect grace window, so they still
 * count as connected.
 */
const userSockets = new Map<string, Set<ClientWebSocket>>();

/** Pending offline transitions per user (see `DISCONNECT_GRACE_MS`). */
const pendingDisconnects = new Map<string, NodeJS.Timeout>();

/** Sockets per room. A room disappears with its last member. */
const roomMembers = new Map<string, Set<ClientWebSocket>>();

/** Cumulative messages broadcast per room, starting from the persisted count (see `wsMessageStore`). */
const roomMessages = new Map<string, number>();

const channelMembers = new Map<string, {ids: string[]; expiresAt: number}>();

function roomMessageCount(room: string): number {
    return roomMessages.get(room) ?? getStoredRoomMessages(room);
}

/** Every websocket frame the server sends goes through here, so the service counter sees all traffic. */
function sendFrame(ws: ClientWebSocket, data: string): void {
    if (ws.readyState !== WebSocket.OPEN) {
        return;
    }
    ws.send(data, (error) => {
        if (error) {
            webSocketCounter.recordFailure(0);
        }
        else {
            webSocketCounter.recordSuccess(0);
        }
    });
}

/** Sends one `{code, payload}` frame to every open socket of each user. */
function sendToUsers(userIds: Iterable<string>, code: string, payload: unknown): void {
    const data = JSON.stringify({code, payload});
    for (const userId of userIds) {
        for (const ws of userSockets.get(userId) ?? []) {
            sendFrame(ws, data);
        }
    }
}

/** Sends one `{code, payload}` frame to every member of `room` and counts it for the room. */
export function broadcastToRoom(room: Room, code: string, payload: unknown): void {
    const members = roomMembers.get(room);
    if (!members?.size) {
        return;
    }
    const data = JSON.stringify({code, payload});
    for (const ws of members) {
        sendFrame(ws, data);
    }
    roomMessages.set(room, roomMessageCount(room) + members.size);
}

/**
 * Returns true if the given room currently has at least one subscriber.
 * Used to gate broadcasters so we never produce traffic when nobody is watching.
 */
export function roomHasSubscribers(room: Room): boolean {
    return (roomMembers.get(room)?.size ?? 0) > 0;
}

/** Per-room message counters, for `saveRoomMessages`. */
export function getRoomMessageCounts(): Record<string, number> {
    return Object.fromEntries(roomMessages);
}

function joinRoom(ws: ClientWebSocket, room: string): void {
    ws.rooms.add(room);
    const members = roomMembers.get(room) ?? new Set<ClientWebSocket>();
    members.add(ws);
    roomMembers.set(room, members);
}

function leaveRoom(ws: ClientWebSocket, room: string): void {
    ws.rooms.delete(room);
    const members = roomMembers.get(room);
    members?.delete(ws);
    if (members?.size === 0) {
        roomMembers.delete(room);
    }
}

/**
 * The server rooms carry the same data as `/auxiliary/health` and
 * `/auxiliary/stats`, so they need the same read permission. Checked on every
 * join, so a removed role applies from the next page visit. Fails closed.
 */
async function canReadServerPerformance(ws: ClientWebSocket): Promise<boolean> {
    try {
        const companyId = new ObjectId(ws.companyId);
        const user = await userService.findByIdOrThrow(ws.userId, {languageCode: ws.languageCode});
        const {isAdmin, permissions} = await user.getCompanyAccess(companyId);
        SchemaGuard.sanitizeFields(ServerPerformance1m, {count: {}}, "read", {
            userId: ws.userId,
            orgId: companyId.toString(),
            isAdmin,
            permissions,
            isSelf: true,
        }, ws.languageCode);
        return true;
    }
    catch {
        return false;
    }
}

async function canJoinRoom(room: unknown, ws: ClientWebSocket): Promise<boolean> {
    if (typeof room !== "string" || !ROOM_ID_PATTERN.test(room)) {
        return false;
    }
    return !SERVER_PERFORMANCE_ROOMS.has(room) || canReadServerPerformance(ws);
}

async function onJoinRoomMessage(payload: unknown, logger: serverLogger, ws: ClientWebSocket): Promise<void> {
    const failed: string[] = [];
    const alreadyJoined: string[] = [];
    const joined: string[] = [];

    for (const room of Array.isArray(payload) ? payload : []) {
        if (typeof room === "string" && ws.rooms.has(room)) {
            alreadyJoined.push(room);
        }
        else if (ws.rooms.size >= MAX_ROOMS_PER_CONNECTION || !(await canJoinRoom(room, ws))) {
            failed.push(String(room));
        }
        else {
            joinRoom(ws, room);
            joined.push(room);
        }
    }

    logger.debug(`User [${ws.userId}] joined [${joined.join(", ")}], already in [${alreadyJoined.join(", ")}], refused [${failed.join(", ")}]`);
    sendFrame(ws, JSON.stringify({
        code: WebSocketMessageCodes.JOIN_ROOM,
        payload: {failed, alreadyJoined, joined}
    }));
}

async function onLeaveRoomMessage(payload: unknown, logger: serverLogger, ws: ClientWebSocket): Promise<void> {
    const alreadyRemovedRooms: string[] = [];
    const removed: string[] = [];

    for (const room of Array.isArray(payload) ? payload : []) {
        if (typeof room === "string" && ws.rooms.has(room)) {
            leaveRoom(ws, room);
            removed.push(room);
        }
        else {
            alreadyRemovedRooms.push(String(room));
        }
    }

    logger.debug(`User [${ws.userId}] left [${removed.join(", ")}], was not in [${alreadyRemovedRooms.join(", ")}]`);
    sendFrame(ws, JSON.stringify({
        code: WebSocketMessageCodes.LEAVE_ROOM,
        payload: {failed: [], alreadyRemovedRooms, removed}
    }));
}

/**
 * Runs one connection's JOIN/LEAVE handlers one at a time. A JOIN awaits a
 * permission check before it updates `ws.rooms`, so overlapping handlers (a
 * quick leave-and-rejoin) could leave the connection out of a room the client
 * still holds. A failed operation does not block later ones.
 */
function queueRoomOperation(ws: ClientWebSocket, operation: () => Promise<void>): Promise<void> {
    const result = (ws.roomOperations ?? Promise.resolve()).then(operation);
    ws.roomOperations = result.catch(() => {});
    return result;
}

/**
 * Member IDs of a channel, cached briefly: typing indicators arrive in bursts
 * and each would otherwise be a Mongo read. A membership change (an agent
 * joining a website chat, a member removed) reaches typing indicators within
 * `CHANNEL_MEMBERS_TTL_MS`.
 */
async function getChannelMemberIds(channelId: string): Promise<string[]> {
    const now = Date.now();
    const cached = channelMembers.get(channelId);
    if (cached && cached.expiresAt > now) {
        return cached.ids;
    }
    const channel = await channelService.findOne({_id: new ObjectId(channelId)}, {}, [], "users");
    const ids = (channel?.users ?? []).map((user: any) => (user?._id ?? user).toString());
    channelMembers.set(channelId, {ids, expiresAt: now + CHANNEL_MEMBERS_TTL_MS});
    return ids;
}

/**
 * Forwards a typing indicator to the channel's other members. The sender is
 * always the connection's own user. A user must be a member of the channel; a
 * visitor's channel comes from its own session (see `onVisitorMessage`).
 */
async function relayTyping(code: string, channelId: string, ws: ClientWebSocket, logger: serverLogger): Promise<void> {
    try {
        const memberIds = await getChannelMemberIds(channelId);
        if (!ws.isVisitor && !memberIds.includes(ws.userId)) {
            logger.debug(`Ignoring typing from ${ws.userId}: not a member of channel ${channelId}`);
            return;
        }
        sendToUsers(memberIds.filter((memberId) => memberId !== ws.userId), code, {
            channelId,
            userId: ws.userId,
            typing: code === WebSocketMessageCodes.TYPING_START,
        });
    }
    catch (error) {
        logger.err(`Error sending typing indicator for channel ${channelId}: ${error}`);
    }
}

function isTypingCode(code: string): boolean {
    return code === WebSocketMessageCodes.TYPING_START || code === WebSocketMessageCodes.TYPING_STOP;
}

/**
 * Handle an inbound message on a visitor connection.
 *
 * Allowlist of exactly one capability — typing indicators, forwarded only to the
 * other members of the visitor's own channel (i.e. an agent who has joined).
 * Everything else is ignored rather than errored, so a curious visitor probing
 * codes learns nothing and stays connected.
 */
async function onVisitorMessage(code: string, logger: serverLogger, ws: ClientWebSocket): Promise<void> {
    // The channel is taken from the CONNECTION, never from the payload, so a
    // visitor cannot address a channel that is not theirs.
    if (!isTypingCode(code) || !ws.visitorChannelId) {
        logger.debug(`Ignoring code [${code}] from visitor connection ${ws.userId}`);
        return;
    }
    await relayTyping(code, ws.visitorChannelId, ws, logger);
}

async function onUserMessage(code: string, payload: any, logger: serverLogger, ws: ClientWebSocket): Promise<void> {
    if (isTypingCode(code)) {
        const channelId = payload?.channelId;
        if (typeof channelId === "string" && ObjectId.isValid(channelId)) {
            await relayTyping(code, channelId, ws, logger);
        }
    }
    else if (code === WebSocketMessageCodes.MESSAGE_RECEIPT_UPDATE) {
        const {channelId, messageIds, kind} = payload ?? {};
        if (typeof channelId !== "string" || !Array.isArray(messageIds) || messageIds.length === 0 || (kind !== "delivered" && kind !== "read")) {
            logger.debug(`MESSAGE_RECEIPT_UPDATE ignored: invalid payload from ${ws.userId}`);
            return;
        }
        try {
            await applyMessageReceipts({
                readerUserId: new ObjectId(ws.userId),
                channelId,
                companyId: new ObjectId(ws.companyId),
                messageIds,
                kind,
                logger,
                languageCode: ws.languageCode,
                auditUserId: ws.userId,
                newPushWebsocketMessage: ({code, userIds, payload}: WebSocketPush<unknown>) => sendToUsers(userIds, code, payload),
            });
        }
        catch (error) {
            logger.err(`MESSAGE_RECEIPT_UPDATE failed for user ${ws.userId}: ${error}`);
        }
    }
    else if (code === WebSocketMessageCodes.JOIN_ROOM) {
        await queueRoomOperation(ws, () => onJoinRoomMessage(payload, logger, ws));
    }
    else if (code === WebSocketMessageCodes.LEAVE_ROOM) {
        await queueRoomOperation(ws, () => onLeaveRoomMessage(payload, logger, ws));
    }
    else {
        // Ignored, not closed: a panel deployed ahead of this server may send codes it does not know yet.
        logger.debug(`Ignoring unknown code [${code}] from ${ws.userId}`);
    }
}

/**
 * Closes the sockets of a revoked session. The `SESSION_REVOKED` notice was
 * just queued on them, and the close frame follows it.
 */
function closeRevokedSession(userIds: string[], sessionId: unknown): void {
    if (typeof sessionId !== "string") {
        return;
    }
    for (const userId of userIds) {
        for (const ws of userSockets.get(userId) ?? []) {
            if (ws.sessionId === sessionId) {
                ws.close(1008, "Session revoked");
            }
        }
    }
}

/** A trusted machine forwards core codes and feature-module codes to the users it names. */
function onMachineMessage(push: Partial<WebSocketPush<any>>, logger: serverLogger, ws: ClientWebSocket): void {
    if (push.code === WebSocketMessageCodes.MACHINE_TO_MACHINE_PING) {
        logger.debug(`[${ws.machineName}] pinged and is alive`);
        return;
    }
    if (typeof push.code !== "string" || !Array.isArray(push.userIds)) {
        return;
    }
    sendToUsers(push.userIds, push.code, push.payload);
    if (push.code === WebSocketMessageCodes.SESSION_REVOKED) {
        closeRevokedSession(push.userIds, push.payload?.sessionId);
    }
}

function withinRateLimit(ws: ClientWebSocket, logger: serverLogger): boolean {
    const now = Date.now();
    if (now - ws.rateWindowStart >= MESSAGE_RATE_WINDOW_MS) {
        ws.rateWindowStart = now;
        ws.rateWindowCount = 0;
    }
    ws.rateWindowCount++;
    if (ws.rateWindowCount === MAX_MESSAGES_PER_WINDOW + 1) {
        logger.warn(`Connection ${ws.id} sent more than ${MAX_MESSAGES_PER_WINDOW} frames in ${MESSAGE_RATE_WINDOW_MS} ms; dropping the rest of this window`);
    }
    return ws.rateWindowCount <= MAX_MESSAGES_PER_WINDOW;
}

async function webSocketOnMessage(message: RawData, ws: ClientWebSocket): Promise<void> {
    const logger = getLogger("webSocketServer-newMessage");

    if (!ws.isMachine && !withinRateLimit(ws, logger)) {
        return;
    }

    try {
        const frame: Partial<WebSocketPush<any>> | null = JSON.parse(message.toString());
        const code = frame?.code;
        if (typeof code !== "string") {
            logger.debug(`Ignoring a frame without a code from ${ws.userId ?? ws.machineName}`);
            return;
        }

        if (ws.isMachine) {
            onMachineMessage(frame!, logger, ws);
        }
        else if (ws.isVisitor) {
            // An anonymous visitor may do exactly one thing over the socket:
            // signal typing in its OWN chat. No rooms, no receipts, no reading
            // another channel.
            await onVisitorMessage(code, logger, ws);
        }
        else {
            await onUserMessage(code, frame!.payload, logger, ws);
        }
    }
    catch (e: any) {
        // Unparseable frames break protocol (1008, final). Anything else is a server-side failure:
        // 1011 lets the client reconnect with backoff and rejoin its rooms.
        const malformed = e instanceof SyntaxError;
        logger.fail(`${malformed ? "Malformed websocket message" : "Websocket message handling failed"}. Terminating. Error: ${e?.message || e}`);
        ws.close(malformed ? 1008 : 1011, malformed ? "Invalid websocket message" : "Internal error");
    }
}

async function updateOnlineStatus(userId: string, online: boolean, logger: serverLogger): Promise<void> {
    try {
        await userService.updateById(new ObjectId(userId), {online}, {logger});
    }
    catch (error: any) {
        logger.err(`Failed to update user online status: ${error.message}`);
    }
}

async function onUserConnectionClose(ws: ClientWebSocket, logger: serverLogger): Promise<void> {
    // Let an in-flight JOIN finish so the rooms it adds are released below.
    await ws.roomOperations;
    for (const room of [...ws.rooms]) {
        leaveRoom(ws, room);
    }

    const userId = ws.userId;
    const sockets = userSockets.get(userId);
    sockets?.delete(ws);
    if (!sockets || sockets.size > 0) {
        return;
    }

    clearTimeout(pendingDisconnects.get(userId));
    pendingDisconnects.set(userId, setTimeout(() => {
        pendingDisconnects.delete(userId);
        // Re-check: a new connection may have arrived during the grace window.
        if (userSockets.get(userId)?.size) {
            return;
        }
        userSockets.delete(userId);
        void updateOnlineStatus(userId, false, logger);
    }, DISCONNECT_GRACE_MS));
}

function setupUserConnection(ws: ClientWebSocket, identity: Extract<ConnectionIdentity, {kind: "user"}>, logger: serverLogger): void {
    const {user, sessionId, expiresAt, languageCode} = identity;
    ws.id = generateRandomString(24) + "_" + user.id;
    ws.userId = user.id;
    ws.username = user.username;
    ws.languageCode = languageCode;
    ws.companyId = String(user.company._id);
    ws.sessionId = sessionId;
    ws.expiresAt = expiresAt;

    ws.on("close", () => void onUserConnectionClose(ws, logger.renew()));

    // If a disconnect was pending for this user (browser refresh, brief
    // network blip), cancel it: the user is back inside the grace window
    // so we never need to flip them offline.
    clearTimeout(pendingDisconnects.get(ws.userId));
    pendingDisconnects.delete(ws.userId);

    const sockets = userSockets.get(ws.userId);
    if (sockets) {
        sockets.add(ws);
    }
    else {
        userSockets.set(ws.userId, new Set([ws]));
        void updateOnlineStatus(ws.userId, true, logger);
    }

    ws.send(`Welcome ${ws.userId}. WS connection is ready.`);
    logger.finish(`Finished setting up connection for user: [${ws.userId}]`);
}

/**
 * Set up a public-website visitor connection.
 *
 * Deliberately a reduced version of the normal connection setup:
 *   - registers in `userSockets` under the visitor id, which is all
 *     `pushWebsocketMessage({userIds: [visitorId]})` needs to reach the widget;
 *   - joins NO rooms — not its own channel room, and certainly not the system
 *     rooms (server-health feeds);
 *   - does NOT touch `user.online`, so an anonymous visitor never appears in presence.
 */
function setupVisitorConnection(ws: ClientWebSocket, identity: Extract<ConnectionIdentity, {kind: "visitor"}>, logger: serverLogger): void {
    const visitorId = identity.session.visitorUser._id.toString();
    const channelId = identity.session.visitorChannel._id.toString();

    const sockets = userSockets.get(visitorId) ?? new Set<ClientWebSocket>();
    if (sockets.size >= MAX_VISITOR_CONNECTIONS) {
        logger.fail(`Visitor ${visitorId} exceeded ${MAX_VISITOR_CONNECTIONS} connections; refusing`);
        ws.close(1008, "Too many connections");
        return;
    }

    ws.id = generateRandomString(24) + "_" + visitorId;
    ws.userId = visitorId;
    ws.username = `visitor:${visitorId}`;
    ws.languageCode = identity.languageCode;
    ws.isVisitor = true;
    ws.visitorChannelId = channelId;

    ws.on("close", () => {
        sockets.delete(ws);
        if (sockets.size === 0 && userSockets.get(visitorId) === sockets) {
            userSockets.delete(visitorId);
        }
    });

    sockets.add(ws);
    userSockets.set(visitorId, sockets);

    ws.send(`Welcome visitor. WS connection is ready.`);
    logger.finish(`Finished setting up visitor connection for chat [${channelId}]`);
}

function setupMachineConnection(ws: ClientWebSocket, machineName: string, logger: serverLogger): void {
    ws.id = generateRandomString(24) + "_machine";
    ws.username = machineName;
    ws.machineName = machineName;
    ws.isMachine = true;
    ws.on("close", (code) => logger.renew().debug(`Machine connection [${machineName}] closed with ${code}`));

    ws.send(`Welcome machine. WS connection is ready.`);
    logger.finish(`A new machine to machine connection was made by [${machineName}]`);
}

function isMachineSecret(token: string): boolean {
    const expected = Buffer.from(MACHINE_TO_MACHINE_SECRET ?? "");
    const given = Buffer.from(token);
    return expected.length > 0 && given.length === expected.length && timingSafeEqual(given, expected);
}

/** Resolves who is connecting from `/<token>/<languageCode>`. Never throws. */
async function authenticateUpgrade(url: string): Promise<ConnectionIdentity> {
    const [token, languageCode] = url.split("/").filter((segment) => segment.length > 0);
    if (!token || !languageCode) {
        return {kind: "rejected", reason: "Invalid websocket url"};
    }

    // The URL's second segment is the machine's name on a machine connection.
    if (isMachineSecret(token)) {
        return {kind: "machine", machineName: languageCode};
    }

    // A visitor token carries `type: "publicChat"`, which validateJWTToken
    // rejects outright, so the two paths can never be confused for one another.
    const visitorSession = await tryResolveVisitorSession({token, languageCode});
    if (visitorSession) {
        return {kind: "visitor", session: visitorSession, languageCode};
    }

    try {
        const user = validateJWTToken(token, languageCode);
        const session = await validateActiveUserSession(
            user,
            new ObjectId(user.id),
            new ObjectId(user.company._id),
            {languageCode}
        );
        const {exp} = user as JWTTokenType & {exp?: number};
        const tokenExpiresAt = typeof exp === "number" ? exp * 1000 : Infinity;
        const sessionExpiresAt = session.expiresAt ? new Date(session.expiresAt).getTime() : Infinity;
        return {
            kind: "user",
            user,
            sessionId: getTokenSessionId(user),
            expiresAt: Math.min(tokenExpiresAt, sessionExpiresAt),
            languageCode,
        };
    }
    catch {
        return {kind: "rejected", reason: "Invalid websocket token"};
    }
}

function setupConnection(ws: ClientWebSocket, identity: ConnectionIdentity): void {
    const logger = getLogger("webSocketServer-newConnection");

    // Without a listener, ws re-throws a protocol error (a malformed or
    // oversized frame) and the whole process crashes. ws closes the socket itself.
    ws.on("error", (error) => logger.renew().debug(`Websocket protocol error on ${ws.id ?? "a rejected connection"}: ${error.message}`));

    if (identity.kind === "rejected") {
        logger.fail(`${identity.reason}, thus the connection cannot proceed further. Terminating.`);
        ws.close(1008, identity.reason);
        return;
    }

    ws.isAlive = true;
    ws.rooms = new Set();
    ws.rateWindowStart = 0;
    ws.rateWindowCount = 0;
    ws.on("pong", () => {
        ws.isAlive = true;
    });
    ws.on("message", (message: RawData) => void webSocketOnMessage(message, ws));

    if (identity.kind === "machine") {
        setupMachineConnection(ws, identity.machineName, logger);
    }
    else if (identity.kind === "visitor") {
        setupVisitorConnection(ws, identity, logger);
    }
    else {
        setupUserConnection(ws, identity, logger);
    }
}

function onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const logger = getLogger("webSocketServer-newConnection");
    logger.start(`New connection inbound from ${req.socket.remoteAddress}, ready to setup the connection`);

    // The raw socket can fail while the token is checked; ws installs its own handler in handleUpgrade.
    const onSocketError = () => socket.destroy();
    socket.on("error", onSocketError);

    void authenticateUpgrade(req.url ?? "")
        .catch((): ConnectionIdentity => ({kind: "rejected", reason: "Invalid websocket token"}))
        .then((identity) => {
            socket.removeListener("error", onSocketError);
            if (socket.destroyed) {
                logger.debug("Client left before its connection was authenticated");
                return;
            }
            const server = identity.kind === "machine" ? machineServer : clientServer;
            server.handleUpgrade(req, socket, head, (ws) => setupConnection(ws as ClientWebSocket, identity));
        });
}

/**
 * Pings every connection and terminates the ones that did not answer the
 * previous ping, and closes connections whose token or session has expired.
 * Runs every `HEARTBEAT_INTERVAL_MS`; exported for tests.
 */
export function sweepConnections(now = Date.now()): void {
    for (const ws of [...clientServer.clients, ...machineServer.clients] as ClientWebSocket[]) {
        if (ws.readyState !== WebSocket.OPEN) {
            continue;
        }
        if (ws.expiresAt !== undefined && now >= ws.expiresAt) {
            ws.close(1008, "Websocket session expired");
            continue;
        }
        if (!ws.isAlive) {
            ws.terminate();
            continue;
        }
        ws.isAlive = false;
        ws.ping();
    }
    for (const [channelId, entry] of channelMembers) {
        if (entry.expiresAt <= now) {
            channelMembers.delete(channelId);
        }
    }
}

/**
 * Binds the WebSocket server to `port` and resolves only once it is listening.
 * Rejects on a bind failure (e.g. EADDRINUSE), so the caller can retry.
 */
export function startWebSocketServer(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const server = http.createServer((_req, res) => {
            res.writeHead(426, {"Content-Type": "text/plain"});
            res.end("Upgrade Required");
        });
        const onBindError = (error: Error) => {
            server.close();
            reject(error);
        };
        server.once("error", onBindError);
        server.on("upgrade", onUpgrade);
        server.listen(port, () => {
            server.off("error", onBindError);
            // Permanent handler installed after the bind, so later runtime errors are logged instead of crashing the process.
            server.on("error", (error: Error) => getLogger("webSocketServer").err(`WebSocket server runtime error: ${error.message}`));
            httpServer = server;
            heartbeat = setInterval(() => sweepConnections(), HEARTBEAT_INTERVAL_MS);
            resolve();
        });
    });
}

/** Closes every connection with 1001 (clients reconnect to the next server) and stops listening. */
export async function stopWebSocketServer(): Promise<void> {
    if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
    }
    for (const timer of pendingDisconnects.values()) {
        clearTimeout(timer);
    }
    pendingDisconnects.clear();
    for (const ws of [...clientServer.clients, ...machineServer.clients]) {
        ws.close(1001, "Server shutting down");
    }

    const server = httpServer;
    httpServer = null;
    if (server) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}

/** Room ids worth showing: rooms with members, and known rooms with broadcast history. */
function listRoomIds(): string[] {
    const ids = new Set(roomMembers.keys());
    for (const id of getKnownRoomIds()) {
        if (roomMessageCount(id) > 0) {
            ids.add(id);
        }
    }
    return [...ids];
}

/** Connected users and room presence, as shown in Server Stats → User activity. */
export function getWebSocketPresenceStats(): ServerStatsDto["websocket"] {
    let totalConnections = 0;
    for (const sockets of userSockets.values()) {
        totalConnections += sockets.size;
    }

    const rooms = listRoomIds().map((id) => {
        const members = roomMembers.get(id) ?? new Set<ClientWebSocket>();
        const users = new Map<string, {id: string; username: string; instances: number}>();
        for (const ws of members) {
            const entry = users.get(ws.userId) ?? {id: ws.userId, username: ws.username, instances: 0};
            entry.instances++;
            users.set(ws.userId, entry);
        }
        return {
            id,
            name: getRoomDisplayName(id),
            userCount: users.size,
            totalInstances: members.size,
            messages: roomMessageCount(id),
            users: [...users.values()],
        };
    });

    return {
        totalUsers: userSockets.size,
        totalConnections,
        totalRooms: rooms.length,
        rooms,
    };
}

/**
 * Returns the in-process WebSocket server health.
 *
 * Meant to be called from the WS server process, which owns the server and the
 * connection and room state. Different from `getWebSocketHealth()` in
 * `connectToWebSocketServer.ts`, which reports the *outbound* M2M client
 * connection (and its circuit breaker) used by the other processes to reach
 * this server.
 */
export function getLocalWebSocketServerHealth(): WebSocketHealth {
    const listening = httpServer?.listening ?? false;
    // Total messages is sourced from the persistent service counter so that
    // the dashboard's KPI tile survives WS server restarts.
    const counterStats = webSocketCounter.getStats();
    const port = WEBSOCKET?.PORT;
    const host = os.hostname();
    return {
        lastStart: uptimeKeeper.getLastStart("websocketServer"),
        connected: listening,
        // 1 = OPEN per the ws spec; we only have a server so report OPEN when listening.
        readyState: listening ? 1 : 3,
        url: port ? `ws://${host}:${port}` : `ws://${host}`,
        serverId: `${host}:${process.pid}`,
        users: userSockets.size,
        rooms: listRoomIds().map(getRoomDisplayName),
        messages: counterStats.completedJobs,
        failedJobs: counterStats.failedJobs,
        totalTime: counterStats.totalTime,
    };
}
