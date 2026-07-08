import type {ApiSelectDatum} from "armonia/src/modules/core/types/shared.types";
import type {ICountry} from "@coreModule/database/schemas/country/country";

export function countryToSelect(country: ICountry): ApiSelectDatum {
    return {
        value: country._id.toString(),
        label: country.name,
    };
}

export function countriesToSelect(countries: ICountry[]): ApiSelectDatum[] {
    return countries.map(countryToSelect);
}
