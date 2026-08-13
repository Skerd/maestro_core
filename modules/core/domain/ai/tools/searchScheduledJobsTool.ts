/**
 * `search_scheduled_jobs` — AI-assistant tool for the health of the automations
 * that run in the background.
 *
 * Answers "did the permit-expiry reminder run last night?", "are any scheduled
 * jobs failing?", "when does the next rent run happen?". These jobs are what
 * send the reminders users expect, so "why didn't I get the notification?" is
 * usually answered here.
 *
 * ADMINISTRATORS ONLY. Job configuration and failure detail are operational
 * internals, so the caller's real role is checked via
 * {@link module:assistantToolAccess.requireCompanyAdmin}.
 *
 * Global jobs (`company: null`) are included alongside this company's own,
 * because the platform-wide schedulers are precisely the ones driving a
 * company's reminders. What is deliberately NOT returned: the `handler` code
 * path and raw error stacks — an operator needs the failure message, not a
 * pointer into the source tree.
 *
 * @module searchScheduledJobsTool
 */

import {z} from "zod";
import {registerAssistantTool} from "@coreModule/domain/ai/tools/toolRegistry";
import type {AssistantTool, AssistantToolContext} from "@coreModule/domain/ai/tools/assistantTool.types";
import {cronJobService} from "@coreModule/database/schemas/cronJob/cronJob.service";
import {cronExecutionService} from "@coreModule/database/schemas/cronExecution/cronExecution.service";
import {accessDenied, requireCompanyAdmin} from "@coreModule/domain/ai/tools/assistantToolAccess";
import {
    DEFAULT_RESULTS,
    companyObjectId,
    findOptions,
    limitArg,
    limitParameter,
    listResult,
    regexClause,
    shortText
} from "@coreModule/domain/ai/tools/assistantToolKit";

const EXECUTION_STATUSES = ["running", "success", "failed", "timeout", "cancelled"];
/** Execution outcomes that mean the job did not do its work. */
const FAILED_STATUSES = ["failed", "timeout"];

const SearchScheduledJobsArgs = z
    .object({
        search: z.string().trim().min(1).optional(),
        activeOnly: z.coerce.boolean().optional(),
        failingOnly: z.coerce.boolean().optional(),
        limit: limitArg
    })
    .strip();

const parameters = {
    type: "object" as const,
    properties: {
        search: {
            type: "string",
            description: "Free text matched against the job code or name, e.g. \"permit\", \"reminder\"."
        },
        activeOnly: {type: "boolean", description: "true = only jobs that are currently enabled."},
        failingOnly: {
            type: "boolean",
            description: "true = only jobs whose most recent run failed or timed out. Prefer this for \"is anything broken\"."
        },
        limit: limitParameter
    },
    required: [] as string[]
};

async function execute(rawArgs: unknown, ctx: AssistantToolContext): Promise<unknown> {
    const args = SearchScheduledJobsArgs.parse(rawArgs ?? {});

    const access = await requireCompanyAdmin(ctx);
    if (!access.allowed) {
        return accessDenied("scheduled job status");
    }

    // This company's own jobs plus the platform-wide schedulers that serve it.
    const query: Record<string, unknown> = {
        $or: [{company: companyObjectId(ctx)}, {scope: "global"}]
    };

    if (args.search != null) {
        const rx = regexClause(args.search);
        // `$and` keeps the scope `$or` intact alongside the search `$or`.
        query.$and = [{$or: [{code: rx}, {name: rx}]}];
    }
    if (args.activeOnly === true) query.active = true;

    const limit = args.limit ?? DEFAULT_RESULTS;

    const jobs = await cronJobService.find(
        query,
        findOptions(ctx),
        undefined,
        "code name description scope active pausedAt type cronExpression interval timezone " +
            "nextRunAt lastRunAt maxRetries singleton",
        {code: 1},
        limit
    );

    // Latest execution per job, fetched one job at a time. The page is at most
    // MAX_RESULTS rows and each query is an indexed lookup on jobId, so this is
    // cheaper and clearer than an aggregation with a correlated sub-pipeline.
    const withRuns = await Promise.all(
        jobs.map(async (j: any) => {
            const [lastRun]: any[] = await cronExecutionService.find(
                {jobId: j._id},
                {logger: ctx.logger},
                undefined,
                "status startedAt finishedAt durationMs attempt error nextRetryAt",
                {startedAt: -1},
                1
            );

            const schedule = j.cronExpression
                ?? (j.interval ? `every ${j.interval.value} ${j.interval.unit}` : null);

            return {
                id: j._id?.toString(),
                code: j.code ?? null,
                name: j.name ?? null,
                description: shortText(j.description, 200),
                scope: j.scope ?? null,
                active: j.active ?? false,
                pausedAt: j.pausedAt ?? null,
                type: j.type ?? null,
                schedule,
                timezone: j.timezone ?? null,
                lastRunAt: j.lastRunAt ?? null,
                nextRunAt: j.nextRunAt ?? null,
                neverRun: j.lastRunAt == null,
                lastRun: lastRun
                    ? {
                        status: lastRun.status ?? null,
                        startedAt: lastRun.startedAt ?? null,
                        finishedAt: lastRun.finishedAt ?? null,
                        durationMs: lastRun.durationMs ?? null,
                        attempt: lastRun.attempt ?? null,
                        // Message only — stacks are internal detail.
                        error: shortText(lastRun.error?.message, 250),
                        nextRetryAt: lastRun.nextRetryAt ?? null
                    }
                    : null
            };
        })
    );

    // Applied after the run lookup because "failing" is a property of the latest
    // execution, which lives in a different collection from the job itself.
    const results = args.failingOnly === true
        ? withRuns.filter((j) => j.lastRun != null && FAILED_STATUSES.includes(j.lastRun.status))
        : withRuns;

    const envelope = await listResult(cronJobService, query, results, ctx);

    return args.failingOnly === true
        ? {
            ...envelope,
            // `total` counts jobs matching the query; the failing filter runs on
            // the fetched page, so saying so prevents a wrong "N jobs failing".
            total: results.length,
            truncated: false,
            note: `Failing jobs found among the ${withRuns.length} job(s) examined. ` +
                `Increase 'limit' to examine more.`,
            executionStatuses: EXECUTION_STATUSES
        }
        : envelope;
}

export const searchScheduledJobsTool: AssistantTool = {
    name: "search_scheduled_jobs",
    description:
        "Check the background automations (scheduled/cron jobs) that send " +
        "reminders and run recurring maintenance: whether each is enabled, its " +
        "schedule, when it last ran and next runs, and how its most recent run " +
        "finished (success, failed, timeout) with the error message if it failed. " +
        "Filter by free text, `activeOnly`, or `failingOnly`. Use this for \"is " +
        "anything broken\", \"did the reminder job run\", or \"why didn't the " +
        "notification go out\". ADMINISTRATORS ONLY: other callers get " +
        "`permissionDenied`, which you should explain plainly.",
    parameters,
    execute
};

/** Registered by the core tool bootstrap (registerAllAssistantTools). */
export function registerScheduledJobsAssistantTools(): void {
    registerAssistantTool(searchScheduledJobsTool);
}
