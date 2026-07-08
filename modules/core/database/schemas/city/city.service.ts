import {BaseCrudService} from "@coreModule/database/services/baseCrudService";
import City, {ICity} from "@coreModule/database/schemas/city/city";

export class CityService extends BaseCrudService<ICity, typeof City> {
    constructor() {
        super(City, "City");
    }
}

export const cityService = new CityService();
