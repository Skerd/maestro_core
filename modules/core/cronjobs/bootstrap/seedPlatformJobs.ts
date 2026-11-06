import {cronJobService} from "@coreModule/database/schemas/cronJob/cronJob.service";
import {companyService} from "@coreModule/database/schemas/company/company.service";
import {seedCronJobsForCompany} from "@coreModule/cronjobs/bootstrap/seedCompanyJobs";
import {getLogger} from "@coreModule/loggers/serverLog";
import {effectiveCompanyModules} from "@coreModule/utilities/modules/companyModules";
import {asCrossTenant} from "@coreModule/utilities/endpoints/tenantScope";

const logger = getLogger("cron_seed");

/** Seeds every company's missing job rows. Kept apart from seedCompanyJobs, which company.ts imports. */
export async function seedPlatformCronJobs(): Promise<void> {
    const companies = await companyService.findModuleGrants();
    if (companies.length === 0) {
        logger.warn("No companies — skipping cron job seed");
        return;
    }
    for (const company of companies) {
        await seedCronJobsForCompany(company._id, effectiveCompanyModules(company));
    }
    // Rows from before jobs were seeded per company have no owner to scope their work to.
    await asCrossTenant("retire cron rows that belong to no company", () =>
        cronJobService.deactivateOwnerless());
}
