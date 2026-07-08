import {BaseCrudService} from "@coreModule/database/services/baseCrudService";
import State, {IState} from "@coreModule/database/schemas/state/state";

export class StateService extends BaseCrudService<IState, typeof State> {
    constructor() {
        super(State, "State");
    }
}

export const stateService = new StateService();
