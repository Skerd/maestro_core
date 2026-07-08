import type {ApiSelectDatum} from "armonia/src/modules/core/types/shared.types";
import type {ICity} from "@coreModule/database/schemas/city/city";

export function cityToSelect(city: ICity): ApiSelectDatum {
    return {
        value: city._id.toString(),
        label: city.name,
    };
}

export function citiesToSelect(cities: ICity[]): ApiSelectDatum[] {
    return cities.map(cityToSelect);
}
