/**
 * AI-Assistant Responder Health & Stats
 *
 * The assistant responder runs as its own process (the dedicated
 * `assistantServer`, Option C). Like the cron scheduler, it makes itself
 * visible to the server-performance UI by publishing a heartbeat to Redis;
 * the health endpoint + WS broadcaster read that heartbeat and surface the
 * assistant as a first-class service card, and the per-minute health
 * snapshotter folds it into the uptime/throughput history graphs.
 *
 * The heartbeat also carries live throughput counters so the UI can show real
 * stats for the assistant:
 *   - `answered` — replies successfully delivered.
 *   - `failed`   — invocations that threw (contained by the consumer's retry).
 *   - `processed` = answered + failed (derived).
 *   - `averageMs` — mean answer-composition time over answered replies.
 *
 * Counters are cumulative for the life of the process. On restart they reset to
 * 0; the history snapshotter computes non-negative deltas, so a reset simply
 * yields a zero-delta minute (same behaviour as every other service counter).
 *
 * @module domain/ai/assistantHealth
 */

import os from "os";
import {isRedisConnected, redisGet, redisSetEx} from "@coreModule/connections/connectToRedis";
import {uptimeKeeper} from "@coreModule/utilities/uptime/uptimeKeeper";

/** Redis key holding the assistant responder's latest heartbeat + counters. */
export const ASSISTANT_HEARTBEAT_KEY = "assistant:responder:heartbeat";

/** TTL for the heartbeat key. Comfortably longer than the publish cadence. */
const HEARTBEAT_TTL_SECONDS = 30;
/** How often the running process refreshes the heartbeat. */
const HEARTBEAT_INTERVAL_MS = 10_000;
/** A heartbeat older than this is treated as "not connected". */
const STALE_MS = 60_000;

/**
 * Health slice for the assistant responder, shaped for the server-performance
 * UI. Mirrors the "connected + counters" model of the other service cards.
 */
export type AssistantResponderHealth = {
    connected: boolean;
    lastHeartbeat?: number;
    lastStart?: number;
    serverId?: string;
    /** answered + failed. */
    processed: number;
    /** Replies delivered. */
    answered: number;
    /** Invocations that threw. */
    failed: number;
    /** Cumulative answer-composition time in ms (over answered replies). */
    totalMs: number;
    /** Mean answer-composition time in ms (0 when nothing answered yet). */
    averageMs: number;
};

// In-process cumulative counters (owned by whichever process runs the consumer).
let answered = 0;
let failed = 0;
let totalMs = 0;
/** Latched once so uptime does not reset on every heartbeat tick. */
let startedAt = 0;
let heartbeatTimer: NodeJS.Timeout | null = null;

/**
 * Records the outcome of one AI-channel responder invocation. Called by
 * {@link respondToAiChannelMessage}. Duration is only accrued for answered
 * replies so `averageMs` reflects real answer-composition time.
 */
export function recordAssistantResult(outcome: "answered" | "failed", durationMs: number): void {
    if (outcome === "answered") {
        answered += 1;
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
 */
export async function publishAssistantHeartbeat(): Promise<void> {
    if (!isRedisConnected()) return;
    try {
        if (!startedAt) {
            startedAt = uptimeKeeper.getLastStart("assistantServer") || Date.now();
        }
        await redisSetEx(ASSISTANT_HEARTBEAT_KEY, HEARTBEAT_TTL_SECONDS, JSON.stringify({
            serverId: `${os.hostname()}:${process.pid}`,
            at: Date.now(),
            lastStart: startedAt,
            answered,
            failed,
            totalMs
        }));
    }
    catch {
        // Heartbeats are best-effort; never propagate.
    }
}

/**
 * Starts the periodic heartbeat. Idempotent. Call once from the process that
 * runs the AI-channel consumer (the dedicated `assistantServer`, or the shared
 * kafkaServer in the Option-B fallback).
 */
export function startAssistantHeartbeat(): void {
    if (heartbeatTimer) return;
    void publishAssistantHeartbeat();
    heartbeatTimer = setInterval(() => void publishAssistantHeartbeat(), HEARTBEAT_INTERVAL_MS);
}

export function stopAssistantHeartbeat(): void {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
}

/**
 * Whether the AI-assistant responder process is currently online, judged by the
 * freshness of its Redis heartbeat (see {@link STALE_MS}). Readable from any
 * process — notably the API server, which uses it to tell a user their message
 * can't be answered right now when the dedicated `assistantServer` is down.
 *
 * Fails "offline" (returns `false`) on any Redis miss/error, matching
 * {@link getAssistantResponderHealth}.
 */
export async function isAssistantResponderOnline(): Promise<boolean> {
    return (await getAssistantResponderHealth()).connected;
}

/**
 * Reads the assistant responder's health slice from the Redis heartbeat.
 * Returns a disconnected zero-stats slice on any miss/error so callers can
 * always render a card.
 */
export async function getAssistantResponderHealth(): Promise<AssistantResponderHealth> {
    const empty: AssistantResponderHealth = {
        connected: false, processed: 0, answered: 0, failed: 0, totalMs: 0, averageMs: 0
    };
    try {
        const raw = await redisGet(ASSISTANT_HEARTBEAT_KEY);
        if (!raw) return empty;
        const p = JSON.parse(raw) as {
            serverId?: string;
            at?: number;
            lastStart?: number;
            answered?: number;
            failed?: number;
            totalMs?: number;
        };
        const answeredN = p.answered ?? 0;
        const failedN = p.failed ?? 0;
        const totalMsN = p.totalMs ?? 0;
        const age = Date.now() - (p.at ?? 0);
        return {
            connected: age < STALE_MS,
            lastHeartbeat: p.at,
            lastStart: p.lastStart || p.at,
            serverId: p.serverId,
            processed: answeredN + failedN,
            answered: answeredN,
            failed: failedN,
            totalMs: totalMsN,
            averageMs: answeredN > 0 ? Math.round(totalMsN / answeredN) : 0
        };
    }
    catch {
        return empty;
    }
}
