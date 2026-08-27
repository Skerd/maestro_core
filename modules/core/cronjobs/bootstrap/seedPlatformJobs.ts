import CronJobModel from "@coreModule/database/schemas/cronJob/cronJob";
import Company from "@coreModule/database/schemas/company/company";
import {seedCronJobsForCompany} from "@coreModule/cronjobs/bootstrap/seedCompanyJobs";
import {getLogger} from "@coreModule/loggers/serverLog";

const logger = getLogger("cron_seed");

/**
 * Upsert one job per company from each registered handler's `defaultJob`.
 * Existing schedule / name / active are left as the company configured them.
 */
export async function seedPlatformCronJobs(): Promise<void> {
    const companies = await Company.find({}).select("_id");
    if (companies.length === 0) {
        logger.warn("No companies — skipping cron job seed");
        return;
    }

    for (const company of companies) {
        await seedCronJobsForCompany(company._id);
    }

    await CronJobModel.updateMany({company: null, active: true}, {$set: {active: false}});
}
