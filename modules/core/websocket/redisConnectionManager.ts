/**
 * Redis-Backed WebSocket Connection Manager
 * 
 * Manages WebSocket connections using Redis for horizontal scaling.
 * Allows multiple server instances to share connection state.
 */

import {getRedisClient, isRedisConnected} from "@coreModule/connections/connectToRedis";
import {serverLogger} from "@coreModule/loggers/serverLog";

const CONNECTION_PREFIX = "ws:connection:";
const USER_CONNECTIONS_PREFIX = "ws:user:";
const ROOM_PREFIX = "ws:room:";
const CONNECTION_TTL = 3600; // 1 hour

export interface ConnectionInfo {
    id: string;
    userId: string;
    username: string;
    languageCode: string;
    rooms: string[];
    machineName?: string;
    isMachine?: boolean;
    connectedAt: string;
    serverId: string;
}

/**
 * Add a user connection
 * 
 * @param connectionId - Unique connection ID
 * @param userId - User ID
 * @param info - Connection information
 * @param logger - Optional logger
 */
export async function addUserConnection(
    connectionId: string,
    userId: string,
    info: Omit<ConnectionInfo, 'id' | 'userId' | 'connectedAt'>,
    logger?: serverLogger
): Promise<void> {
    if (!isRedisConnected()) {
        logger?.warn("Redis not connected, connection tracking disabled");
        return;
    }

    try {
        const redis = getRedisClient();
        const serverId = process.env.SERVER_ID || global.ServerName || 'unknown';
        const connectionInfo: ConnectionInfo = {
            id: connectionId,
            userId,
            ...info,
            connectedAt: new Date().toISOString(),
            serverId
        };

        // Store connection info
        await redis.setEx(
            `${CONNECTION_PREFIX}${connectionId}`,
            CONNECTION_TTL,
            JSON.stringify(connectionInfo)
        );

        // Add to user's connection set
        await redis.sAdd(`${USER_CONNECTIONS_PREFIX}${userId}`, connectionId);
        await redis.expire(`${USER_CONNECTIONS_PREFIX}${userId}`, CONNECTION_TTL);

        // Add to rooms
        for (const room of info.rooms || []) {
            await redis.sAdd(`${ROOM_PREFIX}${room}`, connectionId);
            await redis.expire(`${ROOM_PREFIX}${room}`, CONNECTION_TTL);
        }

        logger?.debug(`Added connection ${connectionId} for user ${userId}`);
    } catch (error: any) {
        logger?.err(`Failed to add user connection: ${error.message}`);
    }
}

/**
 * Remove a user connection
 * 
 * @param connectionId - Connection ID to remove
 * @param logger - Optional logger
 */
export async function removeUserConnection(
    connectionId: string,
    logger?: serverLogger
): Promise<void> {
    if (!isRedisConnected()) {
        return;
    }

    try {
        const redis = getRedisClient();
        
        // Get connection info
        const connectionData = await redis.get(`${CONNECTION_PREFIX}${connectionId}`);
        if (!connectionData) {
            return;
        }

        const connection: ConnectionInfo = JSON.parse(connectionData);
        
        // Remove from user's connection set
        await redis.sRem(`${USER_CONNECTIONS_PREFIX}${connection.userId}`, connectionId);

        // Remove from rooms
        for (const room of connection.rooms || []) {
            await redis.sRem(`${ROOM_PREFIX}${room}`, connectionId);
        }

        // Delete connection info
        await redis.del(`${CONNECTION_PREFIX}${connectionId}`);

        logger?.debug(`Removed connection ${connectionId} for user ${connection.userId}`);
    } catch (error: any) {
        logger?.err(`Failed to remove user connection: ${error.message}`);
    }
}

/**
 * Get all connection IDs for a user
 * 
 * @param userId - User ID
 * @returns Array of connection IDs
 */
export async function getUserConnections(userId: string): Promise<string[]> {
    if (!isRedisConnected()) {
        return [];
    }

    try {
        const redis = getRedisClient();
        return await redis.sMembers(`${USER_CONNECTIONS_PREFIX}${userId}`);
    } catch (error) {
        return [];
    }
}

/**
 * Get all connection IDs in a room
 * 
 * @param room - Room name
 * @returns Array of connection IDs
 */
export async function getRoomConnections(room: string): Promise<string[]> {
    if (!isRedisConnected()) {
        return [];
    }

    try {
        const redis = getRedisClient();
        return await redis.sMembers(`${ROOM_PREFIX}${room}`);
    } catch (error) {
        return [];
    }
}

/**
 * Add connection to a room
 * 
 * @param connectionId - Connection ID
 * @param room - Room name
 * @param logger - Optional logger
 */
export async function addConnectionToRoom(
    connectionId: string,
    room: string,
    logger?: serverLogger
): Promise<void> {
    if (!isRedisConnected()) {
        return;
    }

    try {
        const redis = getRedisClient();
        await redis.sAdd(`${ROOM_PREFIX}${room}`, connectionId);
        await redis.expire(`${ROOM_PREFIX}${room}`, CONNECTION_TTL);

        // Update connection info
        const connectionData = await redis.get(`${CONNECTION_PREFIX}${connectionId}`);
        if (connectionData) {
            const connection: ConnectionInfo = JSON.parse(connectionData);
            if (!connection.rooms.includes(room)) {
                connection.rooms.push(room);
                await redis.setEx(
                    `${CONNECTION_PREFIX}${connectionId}`,
                    CONNECTION_TTL,
                    JSON.stringify(connection)
                );
            }
        }

        logger?.debug(`Added connection ${connectionId} to room ${room}`);
    } catch (error: any) {
        logger?.err(`Failed to add connection to room: ${error.message}`);
    }
}

/**
 * Remove connection from a room
 * 
 * @param connectionId - Connection ID
 * @param room - Room name
 * @param logger - Optional logger
 */
export async function removeConnectionFromRoom(
    connectionId: string,
    room: string,
    logger?: serverLogger
): Promise<void> {
    if (!isRedisConnected()) {
        return;
    }

    try {
        const redis = getRedisClient();
        await redis.sRem(`${ROOM_PREFIX}${room}`, connectionId);

        // Update connection info
        const connectionData = await redis.get(`${CONNECTION_PREFIX}${connectionId}`);
        if (connectionData) {
            const connection: ConnectionInfo = JSON.parse(connectionData);
            connection.rooms = connection.rooms.filter(r => r !== room);
            await redis.setEx(
                `${CONNECTION_PREFIX}${connectionId}`,
                CONNECTION_TTL,
                JSON.stringify(connection)
            );
        }

        logger?.debug(`Removed connection ${connectionId} from room ${room}`);
    } catch (error: any) {
        logger?.err(`Failed to remove connection from room: ${error.message}`);
    }
}

/**
 * Get connection info
 * 
 * @param connectionId - Connection ID
 * @returns Connection info or null
 */
export async function getConnectionInfo(connectionId: string): Promise<ConnectionInfo | null> {
    if (!isRedisConnected()) {
        return null;
    }

    try {
        const redis = getRedisClient();
        const data = await redis.get(`${CONNECTION_PREFIX}${connectionId}`);
        if (!data) {
            return null;
        }
        return JSON.parse(data);
    } catch (error) {
        return null;
    }
}

/**
 * Update connection heartbeat (extends TTL)
 * 
 * @param connectionId - Connection ID
 */
export async function updateConnectionHeartbeat(connectionId: string): Promise<void> {
    if (!isRedisConnected()) {
        return;
    }

    try {
        const redis = getRedisClient();
        await redis.expire(`${CONNECTION_PREFIX}${connectionId}`, CONNECTION_TTL);
    } catch (error) {
        // Ignore errors
    }
}

