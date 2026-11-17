import {City} from "armonia/src/modules/core/api/auxiliary/private/city/city.dto";
import type {StateSimple} from "armonia/src/modules/core/dto/state.dto";
import type {CountrySimple} from "armonia/src/modules/core/dto/country.dto";
import {ICity} from "@coreModule/database/schemas/city/city";
import {StateSimpleSnippet} from "@coreModule/database/schemas/state/state.snippets";
import {CountrySimpleSnippet} from "@coreModule/database/schemas/country/country.snippets";
import {mapSnippet} from "@coreModule/utilities/mappers/common.mapper";
import {datasetCityLocation} from "@coreModule/utilities/helpers/cityLocation";
import {
    mapLifeCycleToDTO,
    mapOwnershipToDTO,
    mapRequestableToDTO,
    mapSoftDeleteToDTO
} from "@coreModule/utilities/mappers/plugin/pluginMappers.dto";

export function cityToDTO(city: ICity): City {
    const state = mapSnippet<StateSimple>()(city.state, StateSimpleSnippet);
    const country = mapSnippet<CountrySimple>()(city.country, CountrySimpleSnippet)!;
    const location = datasetCityLocation(country?.code, state?.code, city.name);
    return {
        _id: city._id.toString(),
        name: city.name,
        state,
        country,
        ...(location ? {location} : {}),
        ...mapSoftDeleteToDTO(city),
        ...mapOwnershipToDTO(city),
        ...mapRequestableToDTO(city),
        ...mapLifeCycleToDTO(city),
    };
}

export function citiesToDTO(cities: ICity[]): City[] {
    return cities.map(cityToDTO);
}
