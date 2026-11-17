import type {ApiSelectDatum} from "armonia/src/modules/core/types/shared.types";
import type {ICountry} from "@coreModule/database/schemas/country/country";
import {countryDisplayName} from "@coreModule/utilities/helpers/countryName";

export function countryToSelect(country: ICountry): ApiSelectDatum {
    return {
        value: country._id.toString(),
        label: countryDisplayName(country.code, country.name),
    };
}

export function countriesToSelect(countries: ICountry[]): ApiSelectDatum[] {
    return countries.map(countryToSelect);
}
