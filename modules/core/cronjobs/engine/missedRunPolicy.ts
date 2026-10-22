import type {CronMissedRunPolicy} from "armonia/src/modules/core/api/auxiliary/private/cronJob/cronJob.constants";

/** Cap catch-up so a long outage cannot trigger thousands of runs. */
export const CATCH_UP_MAX = 100;

/**
 * How many of `due` occurrences to run.
 *
 * A single due occurrence always runs (an on-time tick or Run now).
 * A backlog of 2+ follows the job policy: skip all, run once, or run all.
 * Rows saved before the field existed have no policy and count as "skip".
 */
export function selectRunCount(policy: CronMissedRunPolicy | undefined, due: number): number {
    if (due <= 1) return Math.max(due, 0);
    if (policy === "catch_up") return due;
    if (policy === "run_once") return 1;
    return 0;
}
