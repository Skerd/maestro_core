/**
 * API Server Health & Stats
 *
 * The API (Express) process makes itself visible to the server-performance UI by
 * publishing a heartbeat to Redis. The health endpoint + WS broadcaster read that
 * heartbeat and surface the API as a first-class service card; the per-minute
 * health snapshotter folds it into the uptime/throughput history graphs.
 *
 * The heartbeat carries live request counters so the UI can show:
 *   - `completed` — responses with status < 400.
 *   - `failed`    — responses with status ≥ 400.
 *   - `processed` = completed + failed (derived).
 *   - `averageMs` — mean request duration over all processed requests.
 *
 * Counters are cumulative for the life of the process. On restart they reset to
 * 0; the history snapshotter computes non-negative deltas, so a reset simply
 * yields a zero-delta minute (same behaviour as every other service counter).
 *
 * @module api/health/apiServerHealth
 */

import os from "os";
import {isRedisConnected, redisGet, redisSetEx} from "@coreModule/connections/connectToRedis";
import {uptimeKeeper} from "@coreModule/utilities/uptime/uptimeKeeper";

/** Redis key holding the API server's latest heartbeat + counters. */
export const API_SERVER_HEARTBEAT_KEY = "api:server:heartbeat";

/** TTL for the heartbeat key. Comfortably longer than the publish cadence. */
const HEARTBEAT_TTL_SECONDS = 30;
/** How often the running process refreshes the heartbeat. */
const HEARTBEAT_INTERVAL_MS = 10_000;
/** A heartbeat older than this is treated as "not connected". */
const STALE_MS = 60_000;

/**
 * Health slice for the API server, shaped for the server-performance UI.
 * Mirrors the "connected + counters" model of the cron/assistant cards.
 */
export type ApiServerHealth = {
    connected: boolean;
    lastHeartbeat?: number;
    lastStart?: number;
    serverId?: string;
    /** completed + failed. */
    processed: number;
    /** Responses with status < 400. */
    completed: number;
    /** Responses with status ≥ 400. */
    failed: number;
    /** Cumulative request duration in ms (over all processed requests). */
    totalMs: number;
    /** Mean request duration in ms (0 when nothing processed yet). */
    averageMs: number;
};

// In-process cumulative counters (owned by the API server process).
let completed = 0;
let failed = 0;
let totalMs = 0;
/** Latched once so uptime does not reset on every heartbeat tick. */
let startedAt = 0;
let heartbeatTimer: NodeJS.Timeout | null = null;

/**
 * Records the outcome of one HTTP request. Called from {@link metricsMiddleware}
 * on `res.finish`. Duration is accrued for every request so `averageMs` reflects
 * overall request latency (successes and failures).
 */
export function recordApiResult(outcome: "completed" | "failed", durationMs: number): void {
    if (outcome === "completed") {
        completed += 1;
    }
    else {
        failed += 1;
    }
    if (Number.isFinite(durationMs) && durationMs > 0) {
        totalMs += Math.round(durationMs);
    }
}

/**
 * Publishes the current heartbeat + counters to Redis. Best-effort: a Redis
 * outage silently no-ops (the card will read as "not connected" until it
 * recovers, which is the truthful state).
 */
export async function publishApiHeartbeat(): Promise<void> {
    if (!isRedisConnected()) return;
    try {
        if (!startedAt) {
            startedAt = uptimeKeeper.getLastStart("api") || Date.now();
        }
        await redisSetEx(API_SERVER_HEARTBEAT_KEY, HEARTBEAT_TTL_SECONDS, JSON.stringify({
            serverId: `${os.hostname()}:${process.pid}`,
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
 * Starts the periodic heartbeat. Idempotent. Call once from `apiServer` after
 * Redis is connected and uptime has been marked.
 */
export function startApiHeartbeat(): void {
    if (heartbeatTimer) return;
    void publishApiHeartbeat();
    heartbeatTimer = setInterval(() => void publishApiHeartbeat(), HEARTBEAT_INTERVAL_MS);
}

export function stopApiHeartbeat(): void {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
}

/**
 * Reads the API server's health slice from the Redis heartbeat.
 * Returns a disconnected zero-stats slice on any miss/error so callers can
 * always render a card.
 */
export async function getApiServerHealth(): Promise<ApiServerHealth> {
    const empty: ApiServerHealth = {
        connected: false, processed: 0, completed: 0, failed: 0, totalMs: 0, averageMs: 0,
    };
    try {
        const raw = await redisGet(API_SERVER_HEARTBEAT_KEY);
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
        const processed = completedN + failedN;
        const age = Date.now() - (p.at ?? 0);
        return {
            connected: age < STALE_MS,
            lastHeartbeat: p.at,
            lastStart: p.lastStart || p.at,
            serverId: p.serverId,
            processed,
            completed: completedN,
            failed: failedN,
            totalMs: totalMsN,
            averageMs: processed > 0 ? Math.round(totalMsN / processed) : 0,
        };
    }
    catch {
        return empty;
    }
}
