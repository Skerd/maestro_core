import type {
    CronExecution,
    CronExecutionSummary,
    CronJob,
} from "armonia/src/modules/core/api/auxiliary/private/cronJob/cronJob.dto";
import type {ICronExecution} from "@coreModule/database/schemas/cronExecution/cronExecution";
import type {ICronJob} from "@coreModule/database/schemas/cronJob/cronJob";

function mapCompanyRef(company: any): CronJob["company"] {
    if (!company) return null;
    if (typeof company === "object" && company._id) {
        return {_id: company._id.toString(), name: company.name};
    }
    return {_id: company.toString()};
}

export function cronExecutionToSummary(doc: ICronExecution): CronExecutionSummary {
    return {
        _id: doc._id.toString(),
        status: doc.status,
        startedAt: doc.startedAt.toISOString(),
        finishedAt: doc.finishedAt?.toISOString(),
        durationMs: doc.durationMs,
        attempt: doc.attempt,
    };
}

export function cronExecutionToDTO(doc: ICronExecution, job?: ICronJob): CronExecution {
    return {
        _id: doc._id.toString(),
        jobId: doc.jobId.toString(),
        job: job
            ? {_id: job._id.toString(), code: job.code, name: job.name}
            : undefined,
        company: mapCompanyRef(doc.company),
        status: doc.status,
        startedAt: doc.startedAt.toISOString(),
        finishedAt: doc.finishedAt?.toISOString(),
        durationMs: doc.durationMs,
        serverId: doc.serverId,
        attempt: doc.attempt,
        nextRetryAt: doc.nextRetryAt?.toISOString(),
        logs: doc.logs,
        error: doc.error,
        metadata: doc.metadata as Record<string, unknown> | undefined,
        createdAt: doc.createdAt?.toISOString(),
        updatedAt: doc.updatedAt?.toISOString(),
    };
}

export function cronExecutionsToDTO(docs: ICronExecution[], jobMap?: Map<string, ICronJob>): CronExecution[] {
    return docs.map(d => cronExecutionToDTO(d, jobMap?.get(d.jobId.toString())));
}

export function cronJobToDTO(
    doc: ICronJob,
    extras?: {lastExecution?: ICronExecution; nextRunsPreview?: string[]},
): CronJob {
    return {
        _id: doc._id.toString(),
        company: mapCompanyRef(doc.company),
        scope: doc.scope,
        code: doc.code,
        name: doc.name,
        description: doc.description,
        active: doc.active,
        pausedAt: doc.pausedAt?.toISOString(),
        handler: doc.handler,
        type: doc.type,
        cronExpression: doc.cronExpression,
        interval: doc.interval,
        timezone: doc.timezone,
        nextRunAt: doc.nextRunAt?.toISOString(),
        lastRunAt: doc.lastRunAt?.toISOString(),
        runImmediately: doc.runImmediately,
        maxRetries: doc.maxRetries,
        retryDelaySeconds: doc.retryDelaySeconds,
        timeoutSeconds: doc.timeoutSeconds,
        singleton: doc.singleton,
        allowParallelRuns: doc.allowParallelRuns,
        priority: doc.priority,
        executionStrategy: doc.executionStrategy,
        queueName: doc.queueName,
        missedRunPolicy: doc.missedRunPolicy,
        maxConcurrentRuns: doc.maxConcurrentRuns,
        dependsOn: doc.dependsOn?.map(id => id.toString()),
        handlerVersion: doc.handlerVersion,
        metadata: doc.metadata as Record<string, unknown> | undefined,
        tags: doc.tags,
        createdBy: doc.createdBy
            ? {
                _id: (doc.createdBy as any)._id?.toString?.() ?? doc.createdBy.toString(),
                name: (doc.createdBy as any).name ?? "",
                surname: (doc.createdBy as any).surname ?? "",
            }
            : undefined,
        createdAt: doc.createdAt?.toISOString(),
        updatedAt: doc.updatedAt?.toISOString(),
        deletedAt: doc.deletedAt?.toISOString(),
        lastExecution: extras?.lastExecution ? cronExecutionToSummary(extras.lastExecution) : undefined,
        nextRunsPreview: extras?.nextRunsPreview,
    };
}

export function cronJobsToDTO(
    docs: ICronJob[],
    extrasById?: Map<string, {lastExecution?: ICronExecution; nextRunsPreview?: string[]}>,
): CronJob[] {
    return docs.map(d => cronJobToDTO(d, extrasById?.get(d._id.toString())));
}
