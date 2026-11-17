import {describe, expect, it} from "vitest";
import {Types} from "mongoose";
import {requestContext} from "@coreModule/utilities/endpoints/requestContext";
import {countryToSelect} from "@coreModule/utilities/mappers/country/countryMapper.select";

// TD-F122: country pickers and filter chips read English in every language; the stored name stays as it is.
describe("country select labels", () => {
    const country = {_id: new Types.ObjectId(), name: "United Kingdom", code: "GB"};

    it("name the country in the request's language", () => {
        const label = (languageCode: string) => requestContext.run({languageCode}, () => countryToSelect(country as never).label);
        expect(label("sq-AL")).toBe("Mbretëria e Bashkuar");
        expect(label("de-CH")).toBe("Vereinigtes Königreich");
    });

    it("keep the stored name outside a request or without a code", () => {
        expect(countryToSelect(country as never).label).toBe("United Kingdom");
        expect(requestContext.run({languageCode: "de-CH"}, () => countryToSelect({...country, code: undefined} as never).label)).toBe("United Kingdom");
    });
});
