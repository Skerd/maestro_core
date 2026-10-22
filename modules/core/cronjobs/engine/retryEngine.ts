import type {ICronJob} from "@coreModule/database/schemas/cronJob/cronJob";

const MAX_RETRY_DELAY_MS = 86_400_000;

/** Exponential backoff from `retryDelaySeconds`, plus up to one base delay of jitter, capped at a day. */
export function computeRetryDelayMs(job: Pick<ICronJob, "retryDelaySeconds">, attempt: number): number {
    const base = job.retryDelaySeconds * 1_000;
    const exp = base * Math.pow(2, Math.max(0, attempt - 1));
    const jitter = Math.floor(Math.random() * base);
    return Math.min(exp + jitter, MAX_RETRY_DELAY_MS);
}

export function shouldRetry(attempt: number, maxRetries: number): boolean {
    return attempt <= maxRetries;
}

/** Next attempt number: 1 unless the previous run failed/timed out and queued a retry. */
export function resolveRunAttempt(
    last: {status: string; attempt: number; nextRetryAt?: Date | null} | null | undefined,
): number {
    if (
        last
        && (last.status === "failed" || last.status === "timeout")
        && last.nextRetryAt
    ) {
        return last.attempt + 1;
    }
    return 1;
}
