/**
 * Kafka Server Health & Stats
 *
 * The dedicated `kafkaServer` process makes itself visible to the server-
 * performance UI by publishing a heartbeat to Redis. This is distinct from
 * infrastructure broker health (`getKafkaHealth` / `services.kafka`).
 *
 * The heartbeat carries:
 *   - process identity (`serverId`, `lastStart`)
 *   - consumer registry snapshot (expected / running / list)
 *   - pipeline counters from `kafkaCounter` (completed / failed / totalMs)
 *
 * @module kafka/kafkaServerHealth
 */

import os from "os";
import {isRedisConnected, redisGet, redisSetEx} from "@coreModule/connections/connectToRedis";
import {uptimeKeeper} from "@coreModule/utilities/uptime/uptimeKeeper";
import {kafkaCounter} from "@coreModule/utilities/serviceMetrics/serviceCounters";
import {getKafkaConsumerStatuses} from "@coreModule/kafka/consumerRegistry";
import type {
    KafkaConsumerStatus,
    KafkaServerHealth,
} from "armonia/src/modules/core/api/auxiliary/private/serverHealth/serverHealth.dto";

/** Redis key holding the kafkaServer process heartbeat + counters. */
export const KAFKA_SERVER_HEARTBEAT_KEY = "kafka:server:heartbeat";

const HEARTBEAT_TTL_SECONDS = 30;
const HEARTBEAT_INTERVAL_MS = 10_000;
const STALE_MS = 60_000;

let startedAt = 0;
let heartbeatTimer: NodeJS.Timeout | null = null;

export async function publishKafkaServerHeartbeat(): Promise<void> {
    if (!isRedisConnected()) return;
    try {
        if (!startedAt) {
            startedAt = uptimeKeeper.getLastStart("kafkaServer") || Date.now();
        }
        await kafkaCounter.hydrate().catch(() => {});
        const counters = kafkaCounter.getStats();
        const consumerList = await getKafkaConsumerStatuses();
        const running = consumerList.filter((c) => c.alive).length;

        await redisSetEx(KAFKA_SERVER_HEARTBEAT_KEY, HEARTBEAT_TTL_SECONDS, JSON.stringify({
            serverId: `${os.hostname()}:${process.pid}`,
            at: Date.now(),
            lastStart: startedAt,
            completed: counters.completedJobs,
            failed: counters.failedJobs,
            totalMs: counters.totalTime,
            consumers: {
                expected: consumerList.length,
                running,
                list: consumerList,
            },
        }));
    }
    catch {
        // Heartbeats are best-effort; never propagate.
    }
}

/**
 * Starts the periodic heartbeat. Idempotent. Call once from `kafkaServer`
 * after Redis is connected and uptime has been marked.
 */
export function startKafkaServerHeartbeat(): void {
    if (heartbeatTimer) return;
    void publishKafkaServerHeartbeat();
    heartbeatTimer = setInterval(() => void publishKafkaServerHeartbeat(), HEARTBEAT_INTERVAL_MS);
}

export function stopKafkaServerHeartbeat(): void {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
}

/**
 * Reads the kafkaServer health slice from the Redis heartbeat.
 */
export async function getKafkaServerHealth(): Promise<KafkaServerHealth> {
    const empty: KafkaServerHealth = {
        connected: false,
        processed: 0,
        completed: 0,
        failed: 0,
        totalMs: 0,
        averageMs: 0,
        consumers: {expected: 0, running: 0, list: []},
    };
    try {
        const raw = await redisGet(KAFKA_SERVER_HEARTBEAT_KEY);
        if (!raw) return empty;
        const p = JSON.parse(raw) as {
            serverId?: string;
            at?: number;
            lastStart?: number;
            completed?: number;
            failed?: number;
            totalMs?: number;
            consumers?: {
                expected?: number;
                running?: number;
                list?: KafkaConsumerStatus[];
            };
        };
        const completedN = p.completed ?? 0;
        const failedN = p.failed ?? 0;
        const totalMsN = p.totalMs ?? 0;
        const processed = completedN + failedN;
        const age = Date.now() - (p.at ?? 0);
        const list = p.consumers?.list || [];
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
            consumers: {
                expected: p.consumers?.expected ?? list.length,
                running: p.consumers?.running ?? list.filter((c) => c.alive).length,
                list,
            },
        };
    }
    catch {
        return empty;
    }
}
