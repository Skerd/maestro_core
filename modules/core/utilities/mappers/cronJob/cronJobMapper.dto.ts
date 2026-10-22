import type {
    CronExecution,
    CronExecutionSummary,
    CronJob,
} from "armonia/src/modules/core/api/auxiliary/private/cronJob/cronJob.dto";
import type {CompanyBlank} from "armonia/src/modules/core/dto/company.dto";
import type {ICronExecution} from "@coreModule/database/schemas/cronExecution/cronExecution";
import type {ICronJob} from "@coreModule/database/schemas/cronJob/cronJob";
import {CompanyBlankSnippet} from "@coreModule/database/schemas/company/company.snippets";
import {mapSnippet} from "@coreModule/utilities/mappers/common.mapper";
import {
    mapLifeCycleToDTO,
    mapOwnershipToDTO,
    mapSoftDeleteToDTO,
} from "@coreModule/utilities/mappers/plugin/pluginMappers.dto";

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

export function cronExecutionToDTO(doc: ICronExecution): CronExecution {
    return {
        _id: doc._id.toString(),
        jobId: doc.jobId.toString(),
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
        ...mapOwnershipToDTO(doc),
        ...mapLifeCycleToDTO(doc),
    };
}

export function cronExecutionsToDTO(docs: ICronExecution[]): CronExecution[] {
    return docs.map(cronExecutionToDTO);
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
        company: mapSnippet<CompanyBlank>()(doc.company, CompanyBlankSnippet) ?? null,
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
