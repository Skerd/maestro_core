import {BaseCrudService} from "@coreModule/database/services/baseCrudService";
import ContentReport, {IContentReport} from "@coreModule/database/schemas/contentReport/contentReport";

class ContentReportService extends BaseCrudService<IContentReport, typeof ContentReport> {
    constructor() {
        super(ContentReport, "ContentReport");
    }
}

export const contentReportService = new ContentReportService();
