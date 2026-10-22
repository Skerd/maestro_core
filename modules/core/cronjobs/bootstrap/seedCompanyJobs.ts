import type {ClientSession, Types} from "mongoose";
import CronJobModel, {type ICronJob} from "@coreModule/database/schemas/cronJob/cronJob";
import {computeNextRunAt} from "@coreModule/cronjobs/scheduling/nextRunCalculator";
import {listCronHandlerRegistrations} from "@coreModule/cronjobs/registry/handlerRegistry";
import {loadAllCronHandlers} from "@coreModule/cronjobs/bootstrap/loadAllHandlers";
import {getLogger} from "@coreModule/loggers/serverLog";

const logger = getLogger("cron_seed");

/**
 * Creates the job rows a company is missing, one per registered handler, from
 * the handler's `defaultJob`. Existing rows keep the company's own schedule,
 * name and settings.
 */
export async function seedCronJobsForCompany(
    companyId: Types.ObjectId,
    session?: ClientSession | null,
): Promise<void> {
    if (listCronHandlerRegistrations().length === 0) {
        await loadAllCronHandlers(logger);
    }
    const registrations = listCronHandlerRegistrations();
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
