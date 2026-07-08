import {BaseCrudService} from "@coreModule/database/services/baseCrudService";
import CronExecution, {ICronExecution} from "@coreModule/database/schemas/cronExecution/cronExecution";

class CronExecutionService extends BaseCrudService<ICronExecution, typeof CronExecution> {
    constructor() {
        super(CronExecution, "CronExecution");
    }
}

export const cronExecutionService = new CronExecutionService();
