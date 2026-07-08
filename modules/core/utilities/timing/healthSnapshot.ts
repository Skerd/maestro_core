/**
 * Health Snapshot Cache Constants
 *
 * Single source of truth for the Redis key + TTL the health snapshot is shared
 * under. Imported by both the REST `/auxiliary/health` endpoint (read path)
 * and the WS server broadcaster (write path) so both agree on cache layout.
 *
 * Architecture:
 *  - The WS server is the authoritative producer of `ServerHealthFormResponseType`
 *    because it owns the live `WebSocketServer` instance and its room/user state.
 *  - The WS broadcaster writes the latest envelope into Redis on every tick.
 *  - The REST endpoint reads the envelope when serving GET `/auxiliary/health`
 *    so the API process always returns the WS-authoritative websocket status,
 *    never the M2M-client-side view (which would always be `connected: false`
 *    inside the WS process itself and "depends on M2M client" elsewhere).
 *  - On cache miss the REST endpoint falls back to building from local getters,
 *    which is correct from the API server's POV (it can see Mongo/Redis/Kafka).
 *
 * @module utilities/core/timing/healthSnapshot
 */

/** Redis key holding the latest serialized health envelope. */
export const HEALTH_SNAPSHOT_KEY = "health:status";

/**
 * Redis key for Telegram slice published by the process that runs Telegraf (API).
 * The WebSocket process does not launch the bot, so it merges this snapshot instead
 * of relying on local `isConnected`.
 */
export const TELEGRAM_HEALTH_SNAPSHOT_KEY = "health:telegram";

/**
 * TTL for the snapshot. Slightly longer than the broadcaster cadence (2s) to
 * avoid the cache evaporating between writes and to absorb jitter.
 */
export const HEALTH_SNAPSHOT_TTL_SECONDS = 5;

/** TTL for {@link TELEGRAM_HEALTH_SNAPSHOT_KEY}; publisher refreshes on an interval below this. */
export const TELEGRAM_HEALTH_SNAPSHOT_TTL_SECONDS = 30;
