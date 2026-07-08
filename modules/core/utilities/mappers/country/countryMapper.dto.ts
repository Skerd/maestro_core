import {ICountry} from "@coreModule/database/schemas/country/country";
import {Country} from "armonia/src/modules/core/api/auxiliary/private/country/country.dto";
import {mapOwnershipToDTO, mapSoftDeleteToDTO} from "@coreModule/utilities/mappers/plugin/pluginMappers.dto";

export function countryToDTO(country: ICountry): Country {
    return {
        _id: country._id.toString(),
        name: country.name,
        code: country.code,
        phoneCode: country.phoneCode,
        ...mapSoftDeleteToDTO(country),
        ...mapOwnershipToDTO(country),
    };
}

export function countriesToDTO(countries: ICountry[]): Country[] {
    return countries.map(countryToDTO);
}
