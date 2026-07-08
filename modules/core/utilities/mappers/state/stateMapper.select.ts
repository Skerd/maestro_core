import type {ApiSelectDatum} from "armonia/src/modules/core/types/shared.types";
import type {IState} from "@coreModule/database/schemas/state/state";

export function stateToSelect(state: IState): ApiSelectDatum {
    return {
        value: state._id.toString(),
        label: state.name,
    };
}

export function statesToSelect(states: IState[]): ApiSelectDatum[] {
    return states.map(stateToSelect);
}
