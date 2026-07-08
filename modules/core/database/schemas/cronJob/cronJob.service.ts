import {BaseCrudService} from "@coreModule/database/services/baseCrudService";
import CronJob, {ICronJob} from "@coreModule/database/schemas/cronJob/cronJob";

class CronJobService extends BaseCrudService<ICronJob, typeof CronJob> {
    constructor() {
        super(CronJob, "CronJob");
    }
}

export const cronJobService = new CronJobService();
