import type {CitySimple} from "armonia/src/modules/core/dto/city.dto";
import type {ICity} from "@coreModule/database/schemas/city/city";
import {defineSnippet} from "@coreModule/database/utilities/snippet";

export const CitySimpleSnippet = defineSnippet<ICity, CitySimple>()({
    keys: {
        _id: {},
        name: {},
    },
});
