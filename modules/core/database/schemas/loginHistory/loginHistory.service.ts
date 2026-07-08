import {BaseCrudService} from "@coreModule/database/services/baseCrudService";
import LoginHistory, {ILoginHistory} from "@coreModule/database/schemas/loginHistory/loginHistory";

export class LoginHistoryService extends BaseCrudService<ILoginHistory, typeof LoginHistory> {
    constructor() {
        super(LoginHistory, "LoginHistory");
    }
}

export const loginHistoryService = new LoginHistoryService();
