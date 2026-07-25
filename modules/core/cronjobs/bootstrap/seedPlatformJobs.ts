import CronJobModel from "@coreModule/database/schemas/cronJob/cronJob";
import {computeNextRunAt} from "@coreModule/cronjobs/scheduling/nextRunCalculator";
import {listCronHandlerRegistrations} from "@coreModule/cronjobs/registry/handlerRegistry";
import type {CronJobSeed} from "@coreModule/cronjobs/registry/types";
import {getLogger} from "@coreModule/loggers/serverLog";

const logger = getLogger("cron_seed");

function resolveSeed(reg: {code: string; defaultJob?: Partial<CronJobSeed>}): CronJobSeed | null {
    const partial = reg.defaultJob;
    if (!partial) {
        return null;
    }
    const code = partial.code ?? reg.code;
    const name = partial.name;
    const type = partial.type;
    if (!name || !type) {
        logger.warn(`Skipping seed ${reg.code}: defaultJob requires name and type`);
        return null;
    }
    return {
        code,
        name,
        handler: partial.handler ?? reg.code,
        type,
        cronExpression: partial.cronExpression,
        interval: partial.interval,
        timezone: partial.timezone ?? "UTC",
        active: partial.active,
        singleton: partial.singleton ?? true,
        executionStrategy: partial.executionStrategy ?? "distributed",
        maxRetries: partial.maxRetries,
        retryDelaySeconds: partial.retryDelaySeconds,
        timeoutSeconds: partial.timeoutSeconds,
        priority: partial.priority,
        scope: partial.scope ?? "global",
        missedRunPolicy: partial.missedRunPolicy,
    };
}

/**
 * Upsert platform cron jobs from each registered handler's `defaultJob`.
 * Modules own their seeds; core never lists feature-module job catalogs.
 */
export async function seedPlatformCronJobs(): Promise<void> {
    for (const reg of listCronHandlerRegistrations()) {
        const seed = resolveSeed(reg);
        if (!seed) {
            continue;
        }
        const existing = await CronJobModel.findOne({code: seed.code, company: null});
        const nextRunAt = computeNextRunAt(seed, new Date());
        if (existing) {
            await CronJobModel.updateOne(
                {_id: existing._id},
                {
                    $set: {
                        name: seed.name,
                        handler: seed.handler,
                        type: seed.type,
                        cronExpression: seed.cronExpression,
                        timezone: seed.timezone,
                        active: true,
                        ...(!existing.nextRunAt && nextRunAt ? {nextRunAt} : {}),
                    },
                },
            );
            continue;
        }
        await CronJobModel.create({
            ...seed,
            company: null,
            active: true,
            maxRetries: seed.maxRetries ?? 3,
            retryDelaySeconds: seed.retryDelaySeconds ?? 60,
            timeoutSeconds: seed.timeoutSeconds ?? 600,
            allowParallelRuns: false,
            missedRunPolicy: seed.missedRunPolicy ?? "skip",
            nextRunAt,
        });
        logger.debug(`Seeded cron job ${seed.code}`);
    }
}
