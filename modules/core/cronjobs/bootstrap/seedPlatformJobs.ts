import CronJobModel from "@coreModule/database/schemas/cronJob/cronJob";
import Company from "@coreModule/database/schemas/company/company";
import {seedCronJobsForCompany} from "@coreModule/cronjobs/bootstrap/seedCompanyJobs";
import {getLogger} from "@coreModule/loggers/serverLog";
import {effectiveCompanyModules} from "@coreModule/utilities/modules/companyModules";
import {asCrossTenant} from "@coreModule/utilities/endpoints/tenantScope";

const logger = getLogger("cron_seed");

/** Seeds every company's missing job rows. Kept apart from seedCompanyJobs, which company.ts imports. */
export async function seedPlatformCronJobs(): Promise<void> {
    const companies = await Company.find({}).select("_id modules").lean();
    if (companies.length === 0) {
        logger.warn("No companies — skipping cron job seed");
        return;
    }
    for (const company of companies) {
        await seedCronJobsForCompany(company._id, effectiveCompanyModules(company));
    }
    // Rows from before jobs were seeded per company have no owner to scope their work to.
    await asCrossTenant("retire cron rows that belong to no company", () =>
        CronJobModel.updateMany({company: null, active: true}, {$set: {active: false}}));
}
