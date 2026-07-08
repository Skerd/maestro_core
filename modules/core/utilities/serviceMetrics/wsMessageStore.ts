/**
 * Per-Room Message Counters Persistence
 *
 * Persists the cumulative `AllRoomsUsers[room].messages` counter to Redis so
 * the dashboard's per-room "messages" column survives:
 *  - WS server restarts (e.g. dev hot reload, deploys)
 *  - Page refreshes that empty a room (room is removed from in-memory map
 *    when the last subscriber disconnects, taking the counter with it)
 *
 * Storage layout: a single Redis hash keyed by `ws:rooms:messages` with
 * one field per room id and a numeric stringified value for the counter.
 *
 * The hash is rebuilt on every successful save (`HSET` with the full set of
 * known rooms), and read once at startup with `HGETALL`.
 *
 * @module utilities/core/serviceMetrics/wsMessageStore
 */

import {getLogger} from "@coreModule/loggers/serverLog";
import {getRedisClient, isRedisConnected} from "@coreModule/connections/connectToRedis";

const REDIS_KEY = "ws:rooms:messages";
const logger = getLogger("ws_message_store");

let cachedSnapshot: Record<string, number> = {};
let hydrated = false;

/**
 * Loads the persisted per-room message counters into the local cache.
 * Idempotent. Safe to call when Redis is down (returns silently).
 */ 
export async function hydrateRoomMessages(): Promise<void> { 
    if (!isRedisConnected()) return;
    try {
        const raw = await getRedisClient().hGetAll(REDIS_KEY);
        const next: Record<string, number> = {};
        for (const [field, value] of Object.entries(raw || {})) {
            const n = Number(value);
            if (Number.isFinite(n) && n > 0) next[field] = n;
        }
        cachedSnapshot = next;
        hydrated = true;
    }
    catch (err: any) {
        logger.warn(`hydrateRoomMessages failed: ${err?.message}`);
    }
}

/**
 * Returns the stored cumulative message count for a freshly created room
 * entry. Used by `addRoomToAllRoomsUsers` so a recreated room resumes from
 * its previous counter value rather than 0.
 *
 * Returns 0 if the room has never been seen, the cache hasn't been
 * hydrated yet, or Redis was unavailable on hydrate.
 */
export function getStoredRoomMessages(roomId: string): number {
    if (!hydrated) return 0;
    return cachedSnapshot[roomId] ?? 0;
}

/**
 * Persists the current per-room counters back to Redis as monotonic-up
 * counters. Counters are never decreased, never deleted: a room that has
 * been emptied (all users left, removed from `AllRoomsUsers`) keeps its
 * historical message count. The next subscriber to that room will hydrate
 * the previous count via `getStoredRoomMessages`.
 *
 * Best-effort: on Redis error the in-memory cache is unchanged so the
 * next save retries the same payload.
 */
export async function saveRoomMessages(rooms: Record<string, { messages: number }>): Promise<void> {
    if (!isRedisConnected()) return;
    try {
        const client = getRedisClient();
        const fields: Record<string, string> = {};
        const merged: Record<string, number> = {...cachedSnapshot};

        for (const [roomId, room] of Object.entries(rooms)) {
            if (!room) continue;
            const liveCount = Math.max(0, room.messages | 0);
            const storedCount = cachedSnapshot[roomId] ?? 0;
            // Counters move monotonically upward only; in-memory state may be
            // a partial reflection of total history (e.g. after restart) so we
            // never accept a value lower than what's already persisted.
            const next = Math.max(liveCount, storedCount);
            if (next !== storedCount) {
                fields[roomId] = String(next);
                merged[roomId] = next;
            }
        }

        if (Object.keys(fields).length > 0) {
            await client.hSet(REDIS_KEY, fields);
        }
        cachedSnapshot = merged;
        hydrated = true;
    }
    catch (err: any) {
        logger.warn(`saveRoomMessages failed: ${err?.message}`);
    }
}
