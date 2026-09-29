import {State} from "armonia/src/modules/core/api/auxiliary/private/state/state.dto";
import type {CountrySimple} from "armonia/src/modules/core/dto/country.dto";
import {IState} from "@coreModule/database/schemas/state/state";
import {CountrySimpleSnippet} from "@coreModule/database/schemas/country/country.snippets";
import {mapSnippet} from "@coreModule/utilities/mappers/common.mapper";
import {
    mapLifeCycleToDTO,
    mapOwnershipToDTO,
    mapSoftDeleteToDTO
} from "@coreModule/utilities/mappers/plugin/pluginMappers.dto";

export function stateToDTO(state: IState): State {
    return {
        _id: state._id.toString(),
        name: state.name,
        ...(state.code && {code: state.code}),
        country: mapSnippet<CountrySimple>()(state.country, CountrySimpleSnippet)!,
        ...mapSoftDeleteToDTO(state),
        ...mapOwnershipToDTO(state),
        ...mapLifeCycleToDTO(state)
    };
}

export function statesToDTO(states: IState[]): State[] {
    return states.map(stateToDTO);
}
