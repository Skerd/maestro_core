import {CRON_MISSED_RUN_POLICIES, type CronMissedRunPolicy} from "armonia/src/modules/core/api/auxiliary/private/cronJob/cronJob.constants";

/** Cap catch-up so a long outage cannot enqueue thousands of runs. */
export const CATCH_UP_MAX = 100;

export function resolveMissedRunPolicy(value: unknown): CronMissedRunPolicy {
    for (const policy of CRON_MISSED_RUN_POLICIES) {
        if (value === policy) return policy;
    }
    return "skip";
}

/**
 * How many of `queued` executions to actually run.
 *
 * A single queued item is always run (live Run Now / on-time tick).
 * A backlog of 2+ follows the job policy: skip all, run the last one, or run all.
 */
export function selectRunCount(policy: CronMissedRunPolicy, queued: number): number {
    if (queued <= 0) return 0;
    if (queued === 1) return 1;
    if (policy === "catch_up") return queued;
    if (policy === "run_once") return 1;
    return 0;
}

export function selectMessagesToRun<T>(
    policy: CronMissedRunPolicy,
    messages: T[],
    isBacklog: boolean = false,
): T[] {
    const queued = messages.length > 1 || isBacklog ? Math.max(messages.length, 2) : messages.length;
    const n = selectRunCount(policy, queued);
    if (n === 0) return [];
    if (n >= messages.length) return messages;
    return messages.slice(-n);
}
