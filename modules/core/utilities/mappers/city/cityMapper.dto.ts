import {City} from "armonia/src/modules/core/api/auxiliary/private/city/city.dto";
import {ICity} from "@coreModule/database/schemas/city/city";
import {mapOwnershipToDTO, mapSoftDeleteToDTO} from "@coreModule/utilities/mappers/plugin/pluginMappers.dto";

export function cityToDTO(city: ICity): City {
    return {
        _id: city._id.toString(),
        name: city.name,
        state: city.state ? {
            _id: city.state._id.toString(),
            name: city.state.name
        } : undefined,
        country: city.country ? {
            _id: city.country._id.toString(),
            name: city.country.name,
            code: city.country.code
        } : undefined,
        ...mapSoftDeleteToDTO(city),
        ...mapOwnershipToDTO(city),
    };
}

export function citiesToDTO(cities: ICity[]): City[] {
    return cities.map(cityToDTO);
}
