/**
 * Cron Scheduler Health & Stats
 *
 * The cron server makes itself visible to the server-performance UI by
 * publishing a heartbeat to Redis (while it holds the scheduler leader lock).
 * The health endpoint + WS broadcaster read that heartbeat and surface the
 * cron scheduler as a first-class service card; the per-minute health
 * snapshotter folds it into the uptime/throughput history graphs.
 *
 * The heartbeat also carries live throughput counters so the UI can show real
 * stats for the scheduler, mirroring the AI-assistant card:
 *   - `completed` — jobs that finished successfully.
 *   - `failed`    — jobs that failed or timed out (terminal outcomes).
 *   - `processed` = completed + failed (derived).
 *   - `averageMs` — mean job duration over completed runs.
 *
 * Counters are cumulative for the life of the process. On restart they reset to
 * 0; the history snapshotter computes non-negative deltas, so a reset simply
 * yields a zero-delta minute (same behaviour as every other service counter).
 *
 * @module cronjobs/health/cronSchedulerHealth
 */

import {CRON} from "@coreModule/environment";
import {isRedisConnected, redisGet, redisSetEx} from "@coreModule/connections/connectToRedis";
import {uptimeKeeper} from "@coreModule/utilities/uptime/uptimeKeeper";

/** Redis key holding the cron scheduler's latest heartbeat + counters. */
export const CRON_SCHEDULER_HEARTBEAT_KEY = "cron:scheduler:heartbeat";

/** TTL for the heartbeat key. Comfortably longer than the scheduler tick. */
const HEARTBEAT_TTL_SECONDS = 30;
/** A heartbeat older than this is treated as "not connected". */
const STALE_MS = 60_000;

/**
 * Health slice for the cron scheduler, shaped for the server-performance UI.
 * Mirrors the "connected + counters" model of the assistant service card.
 */
export type CronSchedulerHealth = {
    connected: boolean;
    lastHeartbeat?: number;
    lastStart?: number;
    serverId?: string;
    /** completed + failed. */
    processed: number;
    /** Jobs that finished successfully. */
    completed: number;
    /** Jobs that failed or timed out. */
    failed: number;
    /** Cumulative successful-job duration in ms. */
    totalMs: number;
    /** Mean successful-job duration in ms (0 when nothing completed yet). */
    averageMs: number;
};

// In-process cumulative counters (owned by the cron server process).
let completed = 0;
let failed = 0;
let totalMs = 0;
/** Latched once so uptime does not reset on every heartbeat tick. */
let startedAt = 0;

/**
 * Records the outcome of one cron job execution. Called by {@link jobRunner}
 * after the handler settles. Duration is only accrued for successful runs so
 * `averageMs` reflects real job-handler time.
 */
export function recordCronResult(outcome: "completed" | "failed", durationMs: number): void {
    if (outcome === "completed") {
        completed += 1;
        if (Number.isFinite(durationMs) && durationMs > 0) {
            totalMs += Math.round(durationMs);
        }
    }
    else {
        failed += 1;
    }
}

/**
 * Publishes the current heartbeat + counters to Redis. Best-effort: a Redis
 * outage silently no-ops (the card will read as "not connected" until it
 * recovers, which is the truthful state).
 *
 * Called from the scheduler tick while this process holds the leader lock.
 */
export async function publishSchedulerHeartbeat(): Promise<void> {
    if (!isRedisConnected()) return;
    try {
        if (!startedAt) {
            startedAt = uptimeKeeper.getLastStart("cronServer") || Date.now();
        }
        await redisSetEx(CRON_SCHEDULER_HEARTBEAT_KEY, HEARTBEAT_TTL_SECONDS, JSON.stringify({
            serverId: CRON.SERVER_ID,
            at: Date.now(),
            lastStart: startedAt,
            completed,
            failed,
            totalMs,
        }));
    }
    catch {
        // Heartbeats are best-effort; never propagate.
    }
}

/**
 * Reads the cron scheduler's health slice from the Redis heartbeat.
 * Returns a disconnected zero-stats slice on any miss/error so callers can
 * always render a card.
 */
export async function getCronSchedulerHealth(): Promise<CronSchedulerHealth> {
    const empty: CronSchedulerHealth = {
        connected: false, processed: 0, completed: 0, failed: 0, totalMs: 0, averageMs: 0,
    };
    try {
        const raw = await redisGet(CRON_SCHEDULER_HEARTBEAT_KEY);
        if (!raw) return empty;
        const p = JSON.parse(raw) as {
            serverId?: string;
            at?: number;
            lastStart?: number;
            completed?: number;
            failed?: number;
            totalMs?: number;
        };
        const completedN = p.completed ?? 0;
        const failedN = p.failed ?? 0;
        const totalMsN = p.totalMs ?? 0;
        const age = Date.now() - (p.at ?? 0);
        return {
            connected: age < STALE_MS,
            lastHeartbeat: p.at,
            lastStart: p.lastStart || p.at,
            serverId: p.serverId,
            processed: completedN + failedN,
            completed: completedN,
            failed: failedN,
            totalMs: totalMsN,
            averageMs: completedN > 0 ? Math.round(totalMsN / completedN) : 0,
        };
    }
    catch {
        return empty;
    }
}
