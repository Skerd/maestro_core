import type {ClientSession, Types} from "mongoose";
import CronJobModel, {type ICronJob} from "@coreModule/database/schemas/cronJob/cronJob";
import {computeNextRunAt} from "@coreModule/cronjobs/scheduling/nextRunCalculator";
import {cronHandlerAllowed, listCronHandlerRegistrations} from "@coreModule/cronjobs/registry/handlerRegistry";
import {loadAllCronHandlers} from "@coreModule/cronjobs/bootstrap/loadAllHandlers";
import {getLogger} from "@coreModule/loggers/serverLog";

const logger = getLogger("cron_seed");

/**
 * Creates the job rows a company is missing, one per registered handler of the
 * company's modules, from the handler's `defaultJob`. Existing rows keep the
 * company's own schedule, name and settings.
 */
export async function seedCronJobsForCompany(
    companyId: Types.ObjectId,
    modules: readonly string[],
    session?: ClientSession | null,
): Promise<void> {
    if (listCronHandlerRegistrations().length === 0) {
        await loadAllCronHandlers(logger);
    }
    const registrations = listCronHandlerRegistrations().filter((registration) => cronHandlerAllowed(registration, modules));
    const sessionOpt = session ? {session} : {};

    const existing = await CronJobModel.find(
        {company: companyId, code: {$in: registrations.map((r) => r.code)}},
        "code",
        sessionOpt,
    ).lean<Pick<ICronJob, "code">[]>();
    const seeded = new Set(existing.map((job) => job.code));

    const now = new Date();
    for (const {code, defaultJob} of registrations) {
        if (seeded.has(code)) continue;
        await CronJobModel.create(
            [{
                ...defaultJob,
                code,
                handler: code,
                company: companyId,
                nextRunAt: computeNextRunAt(defaultJob, now) ?? undefined,
            }],
            sessionOpt,
        );
        logger.debug(`Seeded cron job ${code} for company ${companyId.toString()}`);
    }
}

/**
 * Moves a company's overdue jobs of `modules` to their next regular run. Jobs of a module
 * stop running while the company lacks it; without this, re-enabling the module would
 * replay every missed run under a `catch_up` policy.
 */
export async function skipMissedCronRuns(
    companyId: Types.ObjectId,
    modules: readonly string[],
    session?: ClientSession | null,
): Promise<void> {
    const codes = listCronHandlerRegistrations()
        .filter((registration) => registration.module && modules.includes(registration.module))
        .map((registration) => registration.code);
    if (codes.length === 0) return;
    const now = new Date();
    const overdue = await CronJobModel.find({company: companyId, handler: {$in: codes}, nextRunAt: {$lt: now}})
        .session(session ?? null);
    for (const job of overdue) {
        job.nextRunAt = computeNextRunAt(job, now) ?? job.nextRunAt;
        await job.save({session: session ?? undefined});
    }
}
