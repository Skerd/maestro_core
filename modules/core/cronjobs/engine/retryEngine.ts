import type {ICronJob} from "@coreModule/database/schemas/cronJob/cronJob";

export type RetryStrategy = "fixed" | "exponential" | "exponential_jitter";

export function computeRetryDelayMs(
    job: Pick<ICronJob, "retryDelaySeconds">,
    attempt: number,
    strategy: RetryStrategy = "exponential_jitter",
): number {
    const base = job.retryDelaySeconds * 1_000;
    if (strategy === "fixed") return base;
    const exp = base * Math.pow(2, Math.max(0, attempt - 1));
    if (strategy === "exponential") return Math.min(exp, 86_400_000);
    const jitter = Math.floor(Math.random() * base);
    return Math.min(exp + jitter, 86_400_000);
}

export function shouldRetry(attempt: number, maxRetries: number): boolean {
    return attempt <= maxRetries;
}
