import {BaseCrudService} from "@coreModule/database/services/baseCrudService";
import SmtpServer, {ISmtpServer} from "@coreModule/database/schemas/smtpServer/smtpServer";

export class SmtpServerService extends BaseCrudService<ISmtpServer, typeof SmtpServer> {
    constructor() {
        super(SmtpServer, "SmtpServer");
    }
}

export const smtpServerService = new SmtpServerService();
