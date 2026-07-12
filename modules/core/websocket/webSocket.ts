/**
 * WebSocket Server Implementation
 * 
 * Real-time WebSocket server for client connections with:
 * - JWT-based authentication
 * - Room-based messaging (channels, notifications, etc.)
 * - User presence tracking (online/offline status)
 * - Connection management (multiple connections per user)
 * - Heartbeat/ping-pong for connection health
 * - Redis-backed connection state management
 * - Machine-to-machine connections support
 * 
 * Connection Flow:
 * 1. Client connects with JWT token in query string
 * 2. Server validates JWT token
 * 3. Server extracts user information from token
 * 4. Server creates ClientWebSocket instance with user data
 * 5. Server sets up heartbeat mechanism
 * 6. Server adds connection to user's connection pool
 * 7. Server subscribes user to default rooms
 * 
 * Room Types:
 * - Channel rooms: Real-time chat channels (channel:{channelId})
 * - System rooms: System-wide notifications (allUsersList, allChats, siteActivity)
 * - Data rooms: Server health data (mongoData, webSocketData)
 * 
 * Message Types:
 * - Text messages, reactions, pins, typing indicators
 * - System notifications
 * - User presence updates
 * - Channel updates
 * 
 * @module websocket/webSocket
 */

import {ObjectId} from "mongodb";
import WebSocket, {WebSocketServer} from "ws";
import {generateRandomString} from "@coreModule/utilities/helpers";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {validateJWTToken} from "@coreModule/utilities/security/jwtValidator";
import {JWTTokenType} from "armonia/src/modules/core/api/user/public/login/login.form.response.type";
import {MACHINE_TO_MACHINE_SECRET, WEBSOCKET} from "@coreModule/environment";
import {channelService} from "@coreModule/database/schemas/channel/channel.service";
import {userService} from "@coreModule/database/schemas/user/user.service";
import {addUserConnection, removeUserConnection,} from "./redisConnectionManager";
import {WebSocketMessage, WebSocketMessageCodes} from "armonia/src/modules/core/websocket/types";
import {applyMessageReceipts} from "@coreModule/domain/messages/applyMessageReceipts";
import {validateActiveUserSession} from "@coreModule/utilities/security/sessionValidator";
import {webSocketCounter} from "@coreModule/utilities/serviceMetrics/serviceCounters";
import {getStoredRoomMessages} from "@coreModule/utilities/serviceMetrics/wsMessageStore";
import {getKnownRoomIds, getRoomDisplayName} from "@coreModule/websocket/roomRegistry";

/**
 * Extended WebSocket type with client-specific metadata
 */
type ClientWebSocket = WebSocket & {
    /** Unique connection ID */
    id: string;
    /** User ID from JWT token */
    userId: string;
    /** JWT token for authentication */
    token: string;
    /** Heartbeat flag for connection health */
    isAlive: boolean;
    /** Username from JWT token */
    username: string;
    /** User's language code */
    languageCode: string;
    /** Array of room IDs this connection is subscribed to */
    rooms: string[];
    /** Heartbeat timer for ping-pong */
    timer: any,
    /** Connection death timer (closes connection if no pong received) */
    deathTimer: any,
    /** Machine name (for machine-to-machine connections) */
    machineName?: string;
    /** Whether this is a machine-to-machine connection */
    isMachine?: boolean;
}

/** WebSocket server instance (set by updateWebSocketInstance) */
export let ServerWebSocket: WebSocketServer;

/**
 * Map of user IDs to their active WebSocket connections
 * Supports multiple connections per user (multiple tabs/devices)
 */
export const AllUsersWebSockets: {[userId: string]: ClientWebSocket[]} = {};

/**
 * Pending disconnect cleanup timers per user. When the last connection for a
 * user closes we schedule the offline transition for `DISCONNECT_GRACE_MS`
 * later, instead of running it immediately. If the user re-establishes a
 * connection during the grace window (e.g. browser refresh) we cancel the
 * timer and the dashboard never sees a transient `users: 0` blip.
 */
const pendingDisconnectTimers: Record<string, NodeJS.Timeout> = {};
const DISCONNECT_GRACE_MS = 5000;

/**
 * Room metadata type
 */
type RoomType = {
    /** Room ID */
    id: string;
    /** Room display name */
    name: string;
    /** Total messages sent to this room */
    messages: number,
    /** Array of users in this room with instance counts */
    users: {
        id: string,
        username: string,
        instances: number
    }[]
}

/**
 * Map of room IDs to room metadata
 * Tracks all rooms and their subscribers
 */
export const AllRoomsUsers: {[room: string]: RoomType} = {};

function buildRoomEntry(room: string, user: JWTTokenType): RoomType {
    return {
        id: room,
        name: getRoomDisplayName(room),
        messages: getStoredRoomMessages(room),
        users: [{
            id: user.id,
            username: user.username,
            instances: 1
        }]
    };
}

async function addRoomToAllRoomsUsers(room: string, user: JWTTokenType) {
    if (AllRoomsUsers[room]) {
        let found = false;
        for (const tempUser of AllRoomsUsers[room].users) {
            if (tempUser.id === user.id) {
                tempUser.instances++;
                found = true;
            }
        }
        if (!found) {
            AllRoomsUsers[room].users.push({
                id: user.id,
                username: user.username,
                instances: 1
            });
        }
        return;
    }

    // Any room that passed roomLogic should appear in the subscriber map.
    AllRoomsUsers[room] = buildRoomEntry(room, user);
}

/**
 * Hydrates `AllRoomsUsers` with placeholder entries for known rooms whose
 * persisted message counters are non-zero. This ensures the broadcaster's
 * `Object.values(AllRoomsUsers)` snapshot is non-empty even before any user
 * has reconnected after a server restart.
 *
 * Placeholder entries have an empty `users` array — they hold history only.
 * They become "real" rooms (with users) when the first subscriber joins.
 *
 * Call {@link registerAllRoomContributions} before this so module rooms are known.
 */
export function hydrateKnownRoomsFromStore(): void {
    for (const roomId of getKnownRoomIds()) {
        const stored = getStoredRoomMessages(roomId);
        if (stored > 0 && !AllRoomsUsers[roomId]) {
            AllRoomsUsers[roomId] = {
                id: roomId,
                name: getRoomDisplayName(roomId),
                messages: stored,
                users: []
            };
        }
    }
}
async function removeRoomFromAllRoomsUser(room: string, userId: string) {
    let toBeDeleted: string[] = [];
    if( !!AllRoomsUsers[room] ) {
        let found = false;
        for( let tempUser of AllRoomsUsers[room].users ){
            if( tempUser.id === userId ){
                tempUser.instances --;
                found = true;
            }
        }
        if( found ) {
            AllRoomsUsers[room].users = AllRoomsUsers[room].users.filter((x) => x.instances > 0);
            if( AllRoomsUsers[room].users.length === 0 ){
                toBeDeleted.push(room);
            }
        }
    }
    for( let deleteRoom of toBeDeleted ){
        delete AllRoomsUsers[deleteRoom];
    }
    // WebSocketData.rooms = Object.values(AllRoomsUsers);
}

export enum Room {
    SERVER_HEALTH = "serverHealth",
    SERVER_STATS = "serverStats",
    ADMINISTRATION = "administration",
    USERS = "users",
    CHATS = "chats",
    ALL_CHATS = "allChats",
    COMPANY = "company",
    ACCOUNT = "account",
    SECURITY = "security",
    NOTIFICATIONS = "notifications",
    ACTIVITY = "activity",
    CONNECTED_APPS = "connectedApps",
    SERVER_PERFORMANCE = "serverPerformance",
    COMPANIES_CONFIGURATIONS = "companies_configurations",
    ROLES_CONFIGURATIONS = "roles_configurations",
    COUNTRIES_CONFIGURATIONS = "country_configurations",
    STATES_CONFIGURATIONS = "states_configurations",
    CITIES_CONFIGURATIONS = "cities_configurations",
    CURRENCIES_CONFIGURATIONS = "currencies_configurations",
    SMTP_SERVERS_CONFIGURATIONS = "smtpServers_configurations",
    MESSAGING_PROVIDERS_CONFIGURATIONS = "messagingProviders_configurations"
}
export enum RoomCode {
    SERVER_HEALTH = "ServerHealthUpdater",
    SERVER_STATS = "ServerStatsUpdater"
}

/** Site presence rooms from panel routes (e.g. bookings). Max 64 chars; camelCase allowed. */
const SITE_ROOM_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

function isSupportedRoom(room: string): boolean {
    return Object.values(Room).includes(room as Room)
        || getKnownRoomIds().includes(room)
        || SITE_ROOM_ID_PATTERN.test(room);
}

async function roomLogic(room: string, code: string, user: any, logger: serverLogger, ws: ClientWebSocket): Promise<boolean> {
    try {
        if (!isSupportedRoom(room)) {
            throw {message: "Request room not supported"};
        }

        if (room === Room.SERVER_HEALTH) {
            // Optional: push an initial health snapshot on join.
        }
        else if (room === Room.SERVER_STATS) {
            // Optional: push an initial stats snapshot on join.
        }
    }
    catch (e: any) {
        logger.err(e.message);
        return false;
    }
    return true;
}

async function onJoinRoomMessage(code: string, payload: string[], user: any, logger: serverLogger, ws: ClientWebSocket){
    logger.updateSpace();
    logger.debug(`[${code}] Ready to add user [${ws.userId}] to the following rooms: [${payload.join(", ")}]`);

    let concatTheseRooms: string [] = [];
    let alreadyJoinedRooms: string[] = [];
    let failedJoinedRooms: string[] = [];

    if( !ws.rooms){
        ws.rooms = [];
    }
    for( let newRoom of payload ){
        if( !ws.rooms.includes(newRoom)){
            let roomLogicPassed = await roomLogic(newRoom, code, user, logger, ws);
            if( !roomLogicPassed ){
                failedJoinedRooms.push(newRoom);
            }
            else{
                await addRoomToAllRoomsUsers(newRoom, user);
                concatTheseRooms.push(newRoom);
            }
        }
        else{
            alreadyJoinedRooms.push(newRoom);
        }
    }

    if( failedJoinedRooms.length > 0 ){
        logger.debug(`User failed to join rooms: [${failedJoinedRooms.join(", ")}]`);
    }
    if( alreadyJoinedRooms.length > 0 ){
        logger.debug(`User already part of rooms: [${alreadyJoinedRooms.join(", ")}]`);
    }
    if( concatTheseRooms.length > 0 ){
        ws.rooms = ws.rooms.concat(concatTheseRooms);
        logger.debug(`User added to rooms: [${concatTheseRooms.join(", ")}]`);
    }

    logger.debug(`[${code} ${user.id}] Added user '${ws.userId}' to the requested rooms`);
    logger.updateSpace(-1);

    ws.send(JSON.stringify({
        code: WebSocketMessageCodes.JOIN_ROOM,
        payload: {
            failed: failedJoinedRooms,
            alreadyJoined: alreadyJoinedRooms,
            joined: concatTheseRooms
        }
    }));

}
async function onLeaveRoomMessage(code: string, payload: string[], user: any, logger: serverLogger, ws: ClientWebSocket){
    logger.updateSpace();
    logger.debug(`[${code} ${user.id}] Ready to remove user '${ws.userId}' from the following rooms: [${payload.join(", ")}]`);
    let removeTheseRooms: string [] = [];
    let alreadyRemovedRooms: string[] = [];
    let failedLeftRooms: string[] = [];

    if( !ws.rooms){
        ws.rooms = [];
    }
    for( let removeRoom of payload ){
        if( !ws.rooms.includes(removeRoom) ){
            alreadyRemovedRooms.push(removeRoom);
        }
        else{
            let roomLogicPassed = await roomLogic(removeRoom, code, user, logger, ws);
            if( !roomLogicPassed ){
                failedLeftRooms.push(removeRoom);
            }
            else{
                await removeRoomFromAllRoomsUser(removeRoom, user.id);
                removeTheseRooms.push(removeRoom);
            }
        }
    }

    if( failedLeftRooms.length > 0 ){
        logger.debug(`User failed to leave rooms: [${failedLeftRooms.join(", ")}]`);
    }
    if( alreadyRemovedRooms.length > 0 ){
        logger.debug(`User already NOT part of rooms: [${alreadyRemovedRooms.join(", ")}]`);
    }
    if( removeTheseRooms.length > 0 ){
        ws.rooms = ws.rooms.filter((room) => !removeTheseRooms.includes(room));
        logger.debug(`User removed from rooms: [${removeTheseRooms.join(", ")}]`);
    }
    logger.debug(`[${code} ${user.id}] Removed user '${ws.userId}' from the requested rooms`);
    logger.updateSpace(-1);

    ws.send(JSON.stringify({
        code: WebSocketMessageCodes.LEAVE_ROOM,
        payload: {
            failed: failedLeftRooms,
            alreadyRemovedRooms: alreadyRemovedRooms,
            removed: removeTheseRooms
        }
    }))
}

async function webSocketOnMessage<T>(message: string, ws: ClientWebSocket){
    const logger = getLogger("webSocketServer-newMessage");
    logger.start(`Ready to calculate ${ws.isMachine ? "machine" : "client"}'s websocket request`);

    try{
        // WSMessageType
        let receivedData: WebSocketMessage<any> = JSON.parse(message.toString());
        let code = receivedData.code;

        if( !code || !receivedData.payload ){
            logger.fail(`No code or payload sent. Who is this? [${ws.userId}]`);
            ws.send("No code or payload sent. Who are you?");
            ws.close(1008, "Invalid websocket message");
            return;
        }
        // Machine connections can send any code (trusted source)
        // Client connections must use valid codes from the enum
        if( !ws.isMachine && !Object.values(WebSocketMessageCodes).includes(code) ){
            logger.fail(`Code is not correct, this cant be. Who is this? [${ws.userId}]`);
            ws.send("Malicious code detected, net-admin notified.");
            ws.close(1008, "Invalid websocket message code");
            return;
        }

        if( ws.isMachine ){
            // this will handle all messages sent to this websocket server by all connected services (machines)
            if( code === WebSocketMessageCodes.MACHINE_TO_MACHINE_PING ){
                const receivedMessage: WebSocketMessage<{machineName: string}> = JSON.parse(message.toString());
                logger.debug(`[${receivedMessage.payload.machineName}] pinged and is alive`);
            }
            else if( Object.values(WebSocketMessageCodes).includes(code)  ){
                const receivedMessage: WebSocketMessage<T> = JSON.parse(message.toString());
                const {code, payload, userIds} = receivedMessage;
                for( let userId of userIds ){
                    let userWebSockets = AllUsersWebSockets[userId] ?? [];
                    for( let userWebSocket of userWebSockets ){
                        try{
                            userWebSocket.send(JSON.stringify({
                                code,
                                payload
                            }));
                            // WebSocketData.messages ++;
                        }catch(error){
                            logger.err(`Error sending message with code: [${code}] to user ${userId}: ${error}`);
                        }
                    }
                }
            }
        }
        else {
            const userFromToken = validateJWTToken(ws.token, ws.languageCode);
            if( [WebSocketMessageCodes.TYPING_START, WebSocketMessageCodes.TYPING_STOP].includes(code) ){
                try{
                    const receivedMessage: WebSocketMessage<{channelId: string, userId: string}> = JSON.parse(message.toString());
                    const {code, payload} = receivedMessage;
                    if( !payload.channelId || !payload.userId ){
                        return "";
                    }
                    let channelUsers = await channelService.findByIdOrThrow(new ObjectId(payload.channelId), {}, {path: "users", select: "_id"}, "users");
                    let channelUserIds = channelUsers.users?.map((user) => user._id.toString()) || [];
                    for( let channelUserId of channelUserIds ){
                        if( channelUserId !== payload.userId && !!AllUsersWebSockets[channelUserId] ){
                            for( let userWebSocket of AllUsersWebSockets[channelUserId] ){
                                try{
                                    userWebSocket.send(JSON.stringify({
                                        code: code,
                                        payload: {
                                            channelId: payload.channelId,
                                            userId: payload.userId,
                                            typing: code === WebSocketMessageCodes.TYPING_START
                                        }
                                    }))
                                }
                                catch(error){
                                    logger.err(`Error sending typing indicator to user ${channelUserId}: ${error}`);
                                }
                            }
                        }
                    }
                }catch(error){
                    logger.err(`Error sending typing indicator: ${error}`);
                }
            }
            else if ([WebSocketMessageCodes.MESSAGE_RECEIPT_UPDATE].includes(code) ) {
                const receivedMessage: WebSocketMessage<{ channelId?: string; messageIds?: string[]; kind?: "delivered" | "read"; }> = JSON.parse(message.toString());
                const {channelId, messageIds, kind} = receivedMessage.payload;
                if (channelId && Array.isArray(messageIds) && messageIds.length > 0 && (kind === "delivered" || kind === "read")) {
                    try {
                        await applyMessageReceipts({
                            readerUserId: new ObjectId(userFromToken.id),
                            channelId,
                            companyId: new ObjectId(userFromToken.company._id),
                            messageIds,
                            kind,
                            logger,
                            languageCode: ws.languageCode,
                            auditUserId: userFromToken.id,
                            newPushWebsocketMessage: (websocketMessage: any) => {
                                const {code, userIds, payload} = websocketMessage;
                                for( let userId of userIds ){
                                    let userWebSockets = AllUsersWebSockets[userId] ?? [];
                                    for( let userWebSocket of userWebSockets ){
                                        try{
                                            userWebSocket.send(JSON.stringify({
                                                code,
                                                payload
                                            }));
                                            // WebSocketData.messages ++;
                                        }catch(error){
                                            logger.err(`Error sending message with code: [${code}] to user ${userId}: ${error}`);
                                        }
                                    }
                                }
                            }
                        });
                    } catch (err: unknown) {
                        logger.err?.(`MESSAGE_RECEIPT_UPDATE failed for user ${userFromToken.id}: ${err}`);
                    }
                }
                else {
                    logger.debug?.(`MESSAGE_RECEIPT_UPDATE ignored: invalid payload from ${ws.userId}`);
                }
            }
            else if (code === WebSocketMessageCodes.JOIN_ROOM) {
                const receivedMessage: WebSocketMessage<Room[]> = JSON.parse(message.toString());
                await onJoinRoomMessage(code, receivedMessage.payload, userFromToken, logger, ws);
            }
            else if( code === WebSocketMessageCodes.LEAVE_ROOM ) {
                const receivedMessage: WebSocketMessage<Room[]> = JSON.parse(message.toString());
                await onLeaveRoomMessage(code, receivedMessage.payload, userFromToken, logger, ws);
            }
        }

        logger.finish(`Calculated ${ws.isMachine ? "machine" : "client"}'s websocket request ${code}`);
    }
    catch(e: any){
        logger.fail(`Connection token not valid, thus the connection action cannot proceed further. Terminating. Error: ${e?.message || e}`);
        try {
            ws.close(1008, "Invalid websocket message");
        } catch (closeError) {
            // Ignore close errors
        }
        return;
    }
}

export async function webSocketOnNewConnection(ws: ClientWebSocket, req: any){

    const logger = getLogger("webSocketServer-newConnection");
    logger.start(`New connection inbound from ${req.socket.remoteAddress}, ready to setup the connection`);
    logger.debug(`Getting token from cookies in connection header`);

    const splitUrl = req.url.split("/").filter((segment: string) => segment.length > 0);
    if (splitUrl.length < 2) {
        logger.fail(`The connection url is not correct, thus the connection cannot proceed further. Terminating.`);
        ws.send(`The connection url is not correct, thus the connection cannot proceed further. Terminating.`);
        ws.close();
        return;
    }

    const token: string = splitUrl[0] as string;
    const languageCode = splitUrl[1] as string || "en-US";
    if (token) {
        try{
            let userFromToken: JWTTokenType = validateJWTToken(token, languageCode);
            const {id, username} = userFromToken;
            await validateActiveUserSession(
                userFromToken,
                new ObjectId(id),
                new ObjectId(userFromToken.company._id),
                {languageCode}
            );

            ws.id = generateRandomString(24) + "_" + id;
            ws.userId = id;
            ws.token = token;
            ws.isAlive = true;
            ws.username = username;
            ws.languageCode = languageCode;
            ws.rooms = [];

            ws.timer = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.ping();
                }
                ws.deathTimer = setTimeout(() => {
                    ws.isAlive = false;
                    ws.close();
                    logger.renew().debug(`Connection is dead for ${ws.userId ?? "unknown connection"}`)
                }, 5000);
            }, 5000);

            ws.on('pong', () => {
                if (ws.deathTimer) {
                    clearTimeout(ws.deathTimer);
                }
            });
            ws.on("close", async () => {
                clearInterval(ws.timer);
                if (ws.deathTimer) {
                    clearTimeout(ws.deathTimer);
                }
                if (AllUsersWebSockets[ws.userId]) {
                    const filterThese: string[] = [];
                    for (const userWebSocket of AllUsersWebSockets[ws.userId]) {
                        if (userWebSocket.id === ws.id) {
                            filterThese.push(ws.id);
                            for (const room of ws.rooms) {
                                await removeRoomFromAllRoomsUser(room, ws.userId);
                            }
                        }
                    }
                    AllUsersWebSockets[ws.userId] = AllUsersWebSockets[ws.userId].filter(
                        (userWebSocket) => !filterThese.includes(userWebSocket.id)
                    );
                }
                if (AllUsersWebSockets[ws.userId] && AllUsersWebSockets[ws.userId].length === 0) {
                    // Defer the actual offline transition. A browser refresh
                    // closes the socket and reopens it within ~100ms — without
                    // this grace window the dashboard would briefly observe
                    // `users: 0` and `rooms: []`.
                    if (pendingDisconnectTimers[ws.userId]) {
                        clearTimeout(pendingDisconnectTimers[ws.userId]);
                    }
                    const userIdForCleanup = ws.userId;
                    const wsIdForCleanup = ws.id;
                    pendingDisconnectTimers[userIdForCleanup] = setTimeout(async () => {
                        delete pendingDisconnectTimers[userIdForCleanup];
                        // Re-check: a new connection may have arrived during the grace window.
                        if (AllUsersWebSockets[userIdForCleanup] && AllUsersWebSockets[userIdForCleanup].length > 0) {
                            return;
                        }
                        delete AllUsersWebSockets[userIdForCleanup];
                        try {
                            await userService.updateById(
                                new ObjectId(userIdForCleanup),
                                {online: false},
                                {logger}
                            );
                        }
                        catch (error: any) {
                            logger.err(`Failed to update user online status: ${error.message}`);
                        }
                        await removeUserConnection(wsIdForCleanup, logger);
                    }, DISCONNECT_GRACE_MS);
                }
                ws.terminate();
            });
            ws.on('message', async (message: any) => {
                await webSocketOnMessage(message, ws);
            });

            // If a disconnect was pending for this user (browser refresh, brief
            // network blip), cancel it: the user is back inside the grace window
            // so we never need to flip them offline.
            if (pendingDisconnectTimers[ws.userId]) {
                clearTimeout(pendingDisconnectTimers[ws.userId]);
                delete pendingDisconnectTimers[ws.userId];
            }

            const isResumingExistingPresence = Array.isArray(AllUsersWebSockets[ws.userId]) && AllUsersWebSockets[ws.userId].length > 0;

            if (isResumingExistingPresence) {
                AllUsersWebSockets[ws.userId].push(ws);
            }
            else {
                AllUsersWebSockets[ws.userId] = [ws];

                try {
                    await userService.updateById(
                        new ObjectId(ws.userId),
                        {online: true},
                        {logger}
                    );
                }
                catch (error: any) {
                    logger.err(`Failed to update user online status: ${error.message}`);
                }

                await addUserConnection(
                    ws.id,
                    ws.userId,
                    {
                        serverId: "globalServer",
                        username: ws.username,
                        languageCode: ws.languageCode,
                        rooms: ws.rooms || [],
                        machineName: ws.machineName,
                        isMachine: ws.isMachine
                    },
                    logger
                );
            }

            ws.send(`Welcome ${ws.userId}. WS connection is ready.`);

            logger.finish(`Finished setting up connection for user: [${ws.userId}]`);
        }
        catch (e){
            if( token === MACHINE_TO_MACHINE_SECRET ){
                logger.debug("A new machine to machine connection was made.");
                ws.machineName = languageCode;
                ws.isMachine = true;
                ws.on('message', async (message: any) => {
                    await webSocketOnMessage(message, ws);
                });

                ws.timer = setInterval(() => {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.ping();
                    }
                    ws.deathTimer = setTimeout(() => {
                        ws.isAlive = false;
                        clearInterval(ws.timer);
                        if (ws.deathTimer) {
                            clearTimeout(ws.deathTimer);
                        }
                        ws.terminate();
                        logger.renew().debug(`Connection is dead for machine connection [${ws.machineName}]`)
                    }, 1000);
                }, 5000);
                ws.on('pong', () => {
                    if (ws.deathTimer) {
                        clearTimeout(ws.deathTimer);
                    }
                });

                ws.send(`Welcome machine. WS connection is ready.`);
                logger.finish();
            }
            else{
                logger.fail(`Failed to validate token, thus the connection cannot proceed further. Terminating.`);
                ws.close(1008, "Invalid websocket token");
            }
        }
    }
    else{
        logger.fail(`No token found in connection cookies, thus the connection cannot proceed further. Terminating.`);
        ws.close(1008, "Missing websocket token");
    }
}

export function updateWebSocketInstance(newWebSocket: WebSocketServer): void {
    ServerWebSocket = newWebSocket;
}

/**
 * Returns the in-process WebSocket server health.
 *
 * This getter is meant to be called from the WS server process — i.e., the
 * process that *owns* the `WebSocketServer`. It introspects the local server
 * instance, the connection registry, and the room registry and returns the
 * shape consumed by `ServerHealthFormResponseType.services.websocket`.
 *
 * Different from `getWebSocketHealth()` in `connectToWebSocketServer.ts` which
 * reports the *outbound* M2M client connection used by the API process to
 * reach the WS server. That getter is meaningless inside the WS server itself.
 */
export function getLocalWebSocketServerHealth(): import("armonia/src/modules/core/api/auxiliary/private/serverHealth/serverHealth.dto").WebSocketHealth {
    const { uptimeKeeper } = require("@coreModule/utilities/uptime/uptimeKeeper");
    const { webSocketCircuitBreaker } = require("@coreModule/utilities/circuitBreaker");
    const os = require("os") as typeof import("os");

    const listening = !!ServerWebSocket && (ServerWebSocket as any).address?.() != null;
    const totalUsers = Object.keys(AllUsersWebSockets).length;
    // Total messages is sourced from the persistent service counter so that
    // the dashboard's KPI tile survives WS server restarts. The per-room
    // counters in `AllRoomsUsers` (used by the stats endpoint for the
    // breakdown) are persisted separately via `wsMessageStore`.
    const counterStats = webSocketCounter.getStats();
    const roomNames = Object.values(AllRoomsUsers).map((room) => {
        room.name = getRoomDisplayName(room.id);
        return room.name;
    });

    const port = WEBSOCKET?.PORT;
    const host = os.hostname();
    return {
        lastStart: uptimeKeeper.getLastStart("websocketServer"),
        connected: listening,
        // 1 = OPEN per the ws spec; we only have a server so report OPEN when listening.
        readyState: listening ? 1 : 3,
        url: port ? `ws://${host}:${port}` : `ws://${host}`,
        serverId: `${host}:${process.pid}`,
        users: totalUsers,
        rooms: roomNames,
        messages: counterStats.completedJobs,
        failedJobs: counterStats.failedJobs,
        totalTime: counterStats.totalTime,
        circuitBreaker: webSocketCircuitBreaker.getStats()
    }; 
}
