import {ObjectId} from "mongodb";
import {BaseCrudService} from "@coreModule/database/services/baseCrudService";
import SmtpServer, {ISmtpServer} from "@coreModule/database/schemas/smtpServer/smtpServer";

export class SmtpServerService extends BaseCrudService<ISmtpServer, typeof SmtpServer> {
    constructor() {
        super(SmtpServer, "SmtpServer");
    }

    /** The company's active servers in sending order (mail delivery tries them one by one). */
    async findActiveInSequence(companyId: ObjectId): Promise<ISmtpServer[]> {
        return this.model.find({company: companyId, active: true})
            .noDeleted()
            .sort({sequence: 1, name: 1})
            .lean<ISmtpServer[]>();
    }
}

export const smtpServerService = new SmtpServerService();
