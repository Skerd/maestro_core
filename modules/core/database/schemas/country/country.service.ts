import {BaseCrudService} from "@coreModule/database/services/baseCrudService";
import Country, {ICountry} from "@coreModule/database/schemas/country/country";

export class CountryService extends BaseCrudService<ICountry, typeof Country> {
    constructor() {
        super(Country, "Country");
    }
}

export const countryService = new CountryService();
