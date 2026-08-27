import type {ClientSession, Types} from "mongoose";
import CronJobModel from "@coreModule/database/schemas/cronJob/cronJob";
import {computeNextRunAt} from "@coreModule/cronjobs/scheduling/nextRunCalculator";
import {listCronHandlerRegistrations} from "@coreModule/cronjobs/registry/handlerRegistry";
import {loadAllCronHandlers} from "@coreModule/cronjobs/bootstrap/loadAllHandlers";
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
    const cronExpression = partial.cronExpression;
    if (!name || !cronExpression) {
        logger.warn(`Skipping seed ${reg.code}: defaultJob requires name and cronExpression`);
        return null;
    }
    return {
        code,
        name,
        handler: partial.handler ?? reg.code,
        cronExpression,
        active: partial.active,
        maxRetries: partial.maxRetries,
        retryDelaySeconds: partial.retryDelaySeconds,
        timeoutSeconds: partial.timeoutSeconds,
        priority: partial.priority,
    };
}

async function loadSeeds(): Promise<CronJobSeed[]> {
    if (listCronHandlerRegistrations().length === 0) {
        await loadAllCronHandlers(logger);
    }
    const seeds: CronJobSeed[] = [];
    for (const reg of listCronHandlerRegistrations()) {
        const seed = resolveSeed(reg);
        if (seed) {
            seeds.push(seed);
        }
    }
    return seeds;
}

/** Upsert registered handler jobs for one company. Does not clobber schedule/name/active. */
export async function seedCronJobsForCompany(
    companyId: Types.ObjectId,
    session?: ClientSession | null,
): Promise<void> {
    const seeds = await loadSeeds();
    const sessionOpt = session ? {session} : {};
    for (const seed of seeds) {
        const existing = await CronJobModel.findOne(
            {code: seed.code, company: companyId},
            null,
            sessionOpt,
        );
        const nextRunAt = computeNextRunAt(seed, new Date());
        if (existing) {
            await CronJobModel.updateOne(
                {_id: existing._id},
                {
                    $set: {
                        handler: seed.handler,
                        ...(!existing.nextRunAt && nextRunAt ? {nextRunAt} : {}),
                    },
                },
                sessionOpt,
            );
            continue;
        }
        await CronJobModel.create(
            [{
                ...seed,
                company: companyId,
                active: seed.active ?? true,
                maxRetries: seed.maxRetries ?? 3,
                retryDelaySeconds: seed.retryDelaySeconds ?? 60,
                timeoutSeconds: seed.timeoutSeconds ?? 600,
                nextRunAt,
            }],
            sessionOpt,
        );
        logger.debug(`Seeded cron job ${seed.code} for company ${companyId.toString()}`);
    }
}
