import {BaseCrudService} from "@coreModule/database/services/baseCrudService";
import UserSession, {IUserSession} from "@coreModule/database/schemas/userSession/userSession";

export class UserSessionService extends BaseCrudService<IUserSession, typeof UserSession> {
    constructor() {
        super(UserSession, "UserSession");
    }
}

export const userSessionService = new UserSessionService();
