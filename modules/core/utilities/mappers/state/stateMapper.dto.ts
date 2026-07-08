import {State} from "armonia/src/modules/core/api/auxiliary/private/state/state.dto";
import {IState} from "@coreModule/database/schemas/state/state";
import {mapOwnershipToDTO, mapSoftDeleteToDTO} from "@coreModule/utilities/mappers/plugin/pluginMappers.dto";

export function stateToDTO(state: IState): State {
    return {
        _id: state._id.toString(),
        name: state.name,
        ...(state.code && {code: state.code}),
        country: state.country ? {
            _id: state.country._id.toString(),
            name: state.country.name,
            code: state.country.code,
        } : undefined,
        ...mapSoftDeleteToDTO(state),
        ...mapOwnershipToDTO(state)
    };
}

export function statesToDTO(states: IState[]): State[] {
    return states.map(stateToDTO);
}
