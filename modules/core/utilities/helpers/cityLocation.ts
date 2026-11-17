import {City as CityList} from "country-state-city";

type Location = {latitude: number; longitude: number};

/** Per country: `<state code>|<name>` and `|<name>` → location, built on first use from the seed dataset. */
const byCountry = new Map<string, Map<string, Location>>();

function countryIndex(countryCode: string): Map<string, Location> {
    const cached = byCountry.get(countryCode);
    if (cached) return cached;
    const index = new Map<string, Location>();
    for (const city of CityList.getCitiesOfCountry(countryCode) ?? []) {
        const latitude = Number(city.latitude);
        const longitude = Number(city.longitude);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
        index.set(`${city.stateCode}|${city.name}`, {latitude, longitude});
        if (!index.has(`|${city.name}`)) index.set(`|${city.name}`, {latitude, longitude});
    }
    byCountry.set(countryCode, index);
    return index;
}

/**
 * Where a seeded city is, from the `country-state-city` dataset the cities are seeded from (`city.defaults.ts`): by
 * its country code, state code and name, else by country and name. `undefined` for a city the dataset lacks (a
 * requested one), so an address form can centre its map on the picked city (TD-F114) without a stored copy.
 */
export function datasetCityLocation(countryCode: string | undefined, stateCode: string | undefined, name: string | undefined): Location | undefined {
    if (!countryCode || !name) return undefined;
    const index = countryIndex(countryCode);
    return index.get(`${stateCode ?? ""}|${name}`) ?? index.get(`|${name}`);
}
