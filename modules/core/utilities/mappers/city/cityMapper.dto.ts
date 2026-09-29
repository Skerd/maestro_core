import {City} from "armonia/src/modules/core/api/auxiliary/private/city/city.dto";
import type {StateSimple} from "armonia/src/modules/core/dto/state.dto";
import type {CountrySimple} from "armonia/src/modules/core/dto/country.dto";
import {ICity} from "@coreModule/database/schemas/city/city";
import {StateSimpleSnippet} from "@coreModule/database/schemas/state/state.snippets";
import {CountrySimpleSnippet} from "@coreModule/database/schemas/country/country.snippets";
import {mapSnippet} from "@coreModule/utilities/mappers/common.mapper";
import {
    mapLifeCycleToDTO,
    mapOwnershipToDTO,
    mapSoftDeleteToDTO
} from "@coreModule/utilities/mappers/plugin/pluginMappers.dto";

export function cityToDTO(city: ICity): City {
    return {
        _id: city._id.toString(),
        name: city.name,
        state: mapSnippet<StateSimple>()(city.state, StateSimpleSnippet),
        country: mapSnippet<CountrySimple>()(city.country, CountrySimpleSnippet)!,
        ...mapSoftDeleteToDTO(city),
        ...mapOwnershipToDTO(city),
        ...mapLifeCycleToDTO(city),
    };
}

export function citiesToDTO(cities: ICity[]): City[] {
    return cities.map(cityToDTO);
}
