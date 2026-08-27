import type {
    CronExecution,
    CronExecutionSummary,
    CronJob,
} from "armonia/src/modules/core/api/auxiliary/private/cronJob/cronJob.dto";
import type {ICronExecution} from "@coreModule/database/schemas/cronExecution/cronExecution";
import type {ICronJob} from "@coreModule/database/schemas/cronJob/cronJob";
import {mapPopulatedRef} from "@coreModule/utilities/mappers/common.mapper";
import {
    mapLifeCycleToDTO,
    mapOwnershipToDTO,
    mapSoftDeleteToDTO,
} from "@coreModule/utilities/mappers/plugin/pluginMappers.dto";

function mapCompanyRef(company: ICronJob["company"]): CronJob["company"] {
    if (!company) return null;
    const mapped = mapPopulatedRef(company);
    if (mapped?._id) return mapped;
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
        company: doc.company
            ? (mapPopulatedRef(doc.company) ?? {_id: doc.company.toString()})
            : null,
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

export type CronJobDtoExtras = {
    lastExecution?: ICronExecution;
    nextRunsPreview?: string[];
};

export function cronJobToDTO(doc: ICronJob, extras?: CronJobDtoExtras): CronJob {
    return {
        _id: doc._id.toString(),
        code: doc.code,
        name: doc.name,
        description: doc.description,
        active: doc.active,
        pausedAt: doc.pausedAt?.toISOString(),
        handler: doc.handler,
        cronExpression: doc.cronExpression,
        nextRunAt: doc.nextRunAt?.toISOString(),
        lastRunAt: doc.lastRunAt?.toISOString(),
        maxRetries: doc.maxRetries,
        retryDelaySeconds: doc.retryDelaySeconds,
        timeoutSeconds: doc.timeoutSeconds,
        priority: doc.priority,
        missedRunPolicy: doc.missedRunPolicy ?? "skip",
        ...mapSoftDeleteToDTO(doc),
        ...mapOwnershipToDTO(doc),
        ...mapLifeCycleToDTO(doc),
        lastExecution: extras?.lastExecution ? cronExecutionToSummary(extras.lastExecution) : undefined,
        nextRunsPreview: extras?.nextRunsPreview,
    };
}

export function cronJobsToDTO(
    docs: ICronJob[],
    extrasById?: Map<string, CronJobDtoExtras>,
): CronJob[] {
    return docs.map(d => cronJobToDTO(d, extrasById?.get(d._id.toString())));
}
