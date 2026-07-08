/**
 * Kafka Consumer Registry
 *
 * A Redis-backed, cross-process registry that tracks which Kafka consumers
 * are *expected* to run and which ones are *actually* running.
 *
 * Why this exists
 * ---------------
 * The Kafka producer connection state on its own is not a sufficient health
 * indicator. A Kafka cluster can be perfectly reachable (so the broker shows
 * "online") while one or more consumers in a separate process have died,
 * crashed, or never started. The dashboard previously showed only the
 * producer-side "connected: true" — operators had no way to distinguish
 * "everything fine" from "nothing is being consumed".
 *
 * Storage layout
 * --------------
 * One Redis hash, `kafka:consumers`, with one field per consumer. The value
 * is a JSON envelope:
 *
 *   {
 *     "name": "apiAccessPersistence",
 *     "displayName": "API access persistence",
 *     "groupId": "API_ACCESS",
 *     "topic": "api-access",
 *     "lastStart": 1714408712345,
 *     "lastSeen":  1714408727345
 *   }
 *
 * Aliveness
 * ---------
 * A consumer is considered *alive* when `now - lastSeen < STALE_THRESHOLD_MS`.
 * Heartbeats are emitted every `HEARTBEAT_INTERVAL_MS` so the threshold gives
 * us 3x worth of slack before we report it down.
 *
 * Process model
 * -------------
 * The consumer's owning process (kafkaServer / webSocketServer):
 *   1. Calls `register()` once on start. This writes the envelope to Redis.
 *   2. Calls `startHeartbeat()` to emit periodic `lastSeen` updates.
 *   3. Calls `stopHeartbeat()` + `unregister()` on graceful shutdown.
 *
 * Any process (including the API server) can call `getKafkaConsumerStatuses()`
 * to render the dashboard view; it just reads the hash and applies the
 * staleness rule. No need for IPC.
 *
 * Failure modes
 * -------------
 * - Redis down at register time: we still keep an in-memory expectation in
 *   the calling process so a later flush works once Redis recovers.
 * - Redis down at heartbeat time: we silently skip; the next successful
 *   heartbeat will refresh `lastSeen`. The reader will mark the consumer
 *   "stale" until then, which is exactly correct behaviour.
 * - Process killed without unregister: the registry entry remains but its
 *   `lastSeen` stops moving. After STALE_THRESHOLD_MS the reader marks it
 *   not alive. A janitor pass (see `pruneStaleConsumers`) can hard-delete
 *   entries older than a longer window.
 *
 * @module kafka/core/consumerRegistry
 */

import {getLogger} from "@coreModule/loggers/serverLog";
import {getRedisClient, isRedisConnected} from "@coreModule/connections/connectToRedis";
import type {KafkaConsumerStatus} from "armonia/src/modules/core/api/auxiliary/private/serverHealth/serverHealth.dto";

/** Redis hash key — exported for maintenance scripts (must stay in sync). */
export const KAFKA_CONSUMER_REGISTRY_HASH_KEY = "kafka:consumers";

const REGISTRY_KEY = KAFKA_CONSUMER_REGISTRY_HASH_KEY;

/** Heartbeat publication cadence. */
const HEARTBEAT_INTERVAL_MS = 5_000;

/** Aliveness threshold. 3x heartbeat = grace for one missed + jitter. */
const STALE_THRESHOLD_MS = 15_000;

/** Hard-delete entries older than this on the next prune pass. */
const PRUNE_THRESHOLD_MS = 60 * 60 * 1_000; // 1h

const logger = getLogger("kafka_consumer_registry");

/**
 * Stored envelope shape (also returned by getKafkaConsumerStatuses, with the
 * computed `alive` flag layered on top).
 */
interface RegistryEntry {
    name: string;
    displayName: string;
    groupId: string;
    topic: string;
    lastStart: number;
    lastSeen: number;
}

/**
 * Per-consumer registration handle. Owns its heartbeat timer.
 *
 * Created and managed by the consumer's start function. The consumer should
 * keep a reference so it can stop the heartbeat on shutdown.
 */
export class KafkaConsumerRegistration {
    private heartbeatTimer: NodeJS.Timeout | null = null;
    private stopped = false;

    constructor(
        public readonly name: string,
        public readonly displayName: string,
        public readonly groupId: string,
        public readonly topic: string
    ) {}

    /**
     * Records this consumer in the registry with `lastStart` = now and an
     * initial `lastSeen` matching it. Idempotent — calling twice just updates
     * `lastStart` to the latest start time.
     */
    async register(): Promise<void> {
        const now = Date.now();
        await writeEntry({
            name: this.name,
            displayName: this.displayName,
            groupId: this.groupId,
            topic: this.topic,
            lastStart: now,
            lastSeen: now
        });
    }

    /**
     * Begins the heartbeat loop. Each tick refreshes `lastSeen` only — never
     * `lastStart` — so the original start time keeps showing on the UI.
     */
    startHeartbeat(): void {
        if (this.heartbeatTimer || this.stopped) return;
        this.heartbeatTimer = setInterval(() => {
            void this.tick();
        }, HEARTBEAT_INTERVAL_MS);
    }

    /**
     * Stops the heartbeat loop. Does NOT remove the registry entry; call
     * `unregister()` for that. We separate the two so a crashing consumer
     * leaves a stale entry in the registry (visible in the UI as "down")
     * rather than disappearing without a trace.
     */
    stopHeartbeat(): void {
        this.stopped = true;
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    /**
     * Removes the entry from the registry. Call only on *graceful* shutdown
     * (e.g. SIGTERM), never on a crash or container kill — otherwise the UI
     * would show "all consumers up" while the process is actually dead.
     */
    async unregister(): Promise<void> {
        this.stopHeartbeat();
        if (!isRedisConnected()) return;
        try {
            await getRedisClient().hDel(REGISTRY_KEY, this.name);
        }
        catch (err: any) {
            logger.warn(`unregister(${this.name}) failed: ${err?.message}`);
        }
    }

    private async tick(): Promise<void> {
        if (!isRedisConnected()) return;
        try {
            const client = getRedisClient();
            // Re-read so we don't clobber a peer's `lastStart` if two processes
            // share the same `name` (which is a misconfiguration but should
            // not corrupt the registry).
            const raw = await client.hGet(REGISTRY_KEY, this.name);
            const existing: RegistryEntry | null = raw ? safeParse(raw) : null;
            await writeEntry({
                name: this.name,
                displayName: this.displayName,
                groupId: this.groupId,
                topic: this.topic,
                lastStart: existing?.lastStart || Date.now(),
                lastSeen: Date.now()
            });
        }
        catch (err: any) {
            logger.warn(`heartbeat(${this.name}) failed: ${err?.message}`);
        }
    }
}

/**
 * Atomic write of one registry entry. Used by both `register` and `tick`.
 */
async function writeEntry(entry: RegistryEntry): Promise<void> {
    if (!isRedisConnected()) return;
    try {
        await getRedisClient().hSet(REGISTRY_KEY, entry.name, JSON.stringify(entry));
    }
    catch (err: any) {
        logger.warn(`writeEntry(${entry.name}) failed: ${err?.message}`);
    }
}

function safeParse(raw: string): RegistryEntry | null {
    try {
        const parsed = JSON.parse(raw) as RegistryEntry;
        if (!parsed?.name) return null;
        return parsed; 
    }
    catch {
        return null;
    }
}

/**
 * Returns the consumer roster for the dashboard. Each entry's `alive` flag
 * is computed from `lastSeen` against the staleness threshold so the caller
 * doesn't need to know about heartbeat cadence.
 *
 * Safe to call from any process. Falls back to an empty list on Redis error
 * so the health endpoint never fails just because the registry is unreachable.
 */
export async function getKafkaConsumerStatuses(): Promise<KafkaConsumerStatus[]> {
    if (!isRedisConnected()) return [];
    try {
        const raw = await getRedisClient().hGetAll(REGISTRY_KEY);
        const now = Date.now();
        const out: KafkaConsumerStatus[] = [];
        for (const [, value] of Object.entries(raw || {})) {
            const entry = safeParse(value);
            if (!entry) continue;
            out.push({
                name: entry.name,
                displayName: entry.displayName,
                groupId: entry.groupId,
                topic: entry.topic,
                lastSeen: entry.lastSeen || 0,
                lastStart: entry.lastStart || 0,
                alive: !!entry.lastSeen && (now - entry.lastSeen) < STALE_THRESHOLD_MS
            });
        }
        // Stable ordering by name for predictable UI rendering.
        out.sort((a, b) => a.name.localeCompare(b.name));
        return out;
    }
    catch (err: any) {
        logger.warn(`getKafkaConsumerStatuses failed: ${err?.message}`);
        return [];
    }
}

/**
 * Hard-deletes registry entries that haven't been seen in PRUNE_THRESHOLD_MS.
 * Useful to clear out old `name`s after a refactor; not needed for normal
 * operation since the staleness flag already does the right thing for the UI.
 *
 * Idempotent and safe to run from any process.
 */
export async function pruneStaleConsumers(): Promise<number> {
    if (!isRedisConnected()) return 0;
    try {
        const client = getRedisClient();
        const raw = await client.hGetAll(REGISTRY_KEY);
        const now = Date.now();
        const stale: string[] = [];
        for (const [field, value] of Object.entries(raw || {})) {
            const entry = safeParse(value);
            if (!entry) {
                stale.push(field);
                continue;
            }
            if (!entry.lastSeen || (now - entry.lastSeen) > PRUNE_THRESHOLD_MS) {
                stale.push(field);
            }
        }
        if (stale.length > 0) {
            await client.hDel(REGISTRY_KEY, stale);
        }
        return stale.length;
    }
    catch (err: any) {
        logger.warn(`pruneStaleConsumers failed: ${err?.message}`);
        return 0;
    }
}
