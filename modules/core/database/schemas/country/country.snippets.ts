import type {CountrySimple} from "armonia/src/modules/core/dto/country.dto";
import type {ICountry} from "@coreModule/database/schemas/country/country";
import {defineSnippet} from "@coreModule/database/utilities/snippet";

export const CountrySimpleSnippet = defineSnippet<ICountry, CountrySimple>()({
    keys: {
        _id: {},
        name: {},
        code: {},
        phoneCode: {},
    },
});
