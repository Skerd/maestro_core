import {describe, expect, it} from "vitest";
import {Types} from "mongoose";
import {datasetCityLocation} from "@coreModule/utilities/helpers/cityLocation";
import {cityToDTO} from "@coreModule/utilities/mappers/city/cityMapper.dto";

// TD-F114: picking a city in an address form neither moved the map nor placed the pin; cities stored no location.
describe("city location", () => {
    it("comes from the seed dataset by country, state and name, else by country and name", () => {
        expect(datasetCityLocation("AL", "TR", "Tirana")).toEqual({latitude: 41.3275, longitude: 19.81889});
        expect(datasetCityLocation("AL", undefined, "Tirana")).toEqual({latitude: 41.3275, longitude: 19.81889});
        expect(datasetCityLocation("AL", "TR", "A town the dataset lacks")).toBeUndefined();
        expect(datasetCityLocation(undefined, "TR", "Tirana")).toBeUndefined();
    });

    it("is part of a city's DTO", () => {
        const city = {
            _id: new Types.ObjectId(),
            name: "Tirana",
            state: {_id: new Types.ObjectId(), name: "Tirana District", code: "TR"},
            country: {_id: new Types.ObjectId(), name: "Albania", code: "AL"},
        };
        expect(cityToDTO(city as never).location).toEqual({latitude: 41.3275, longitude: 19.81889});
    });
});
