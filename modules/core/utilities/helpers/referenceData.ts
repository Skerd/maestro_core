/**
 * Every company holds its own copy of the shared reference data (currencies, countries, states, cities). A record that
 * a flow writes into another company (D143: a portal buyer's job into the marketplace operator) must name that company's
 * copy, found by its stable key: the ISO code of a currency or country, a state's code within its country, a city's
 * name within its state (or its country when it has none). The reads span companies, so they run cross-tenant.
 *
 * @module utilities/helpers/referenceData
 */

import {ObjectId} from "mongodb";
import {asCrossTenant} from "@coreModule/utilities/endpoints/tenantScope";
import {currencyService} from "@coreModule/database/schemas/currency/currency.service";
import {countryService} from "@coreModule/database/schemas/country/country.service";
import {stateService} from "@coreModule/database/schemas/state/state.service";
import {cityService} from "@coreModule/database/schemas/city/city.service";
import type {CrudOptions} from "@coreModule/database/services/baseCrudService";

const REASON = "a record written into another company names that company's copy of the reference data";

type Ref = ObjectId | string;
const id = (ref: Ref) => new ObjectId(String(ref));

/** The target company's currency with the same ISO code as `currency`; undefined when it has none. */
export function sameCurrencyIn(targetCompanyId: Ref, currency: Ref, opts: CrudOptions = {}): Promise<ObjectId | undefined> {
    return asCrossTenant(REASON, async () => {
        const source = await currencyService.findById(id(currency), opts, undefined, "abbreviation company");
        if (!source) return undefined;
        if (String(source.company) === String(targetCompanyId)) return source._id;
        const match = await currencyService.findOne({company: id(targetCompanyId), abbreviation: source.abbreviation}, opts, undefined, "_id");
        return match?._id;
    });
}

export type PlaceRefs = {country?: Ref; state?: Ref; city?: Ref};
export type SamePlaces = {country?: ObjectId; state?: ObjectId; city?: ObjectId};

/**
 * The target company's country, state and city matching `place`. A part that is not given, or that the target does
 * not have, comes back undefined; a state or city is only matched inside the matched country (and state).
 */
export function samePlacesIn(targetCompanyId: Ref, place: PlaceRefs, opts: CrudOptions = {}): Promise<SamePlaces> {
    return asCrossTenant(REASON, async () => {
        const company = id(targetCompanyId);
        const [country, state, city] = await Promise.all([
            place.country ? countryService.findById(id(place.country), opts, undefined, "code") : null,
            place.state ? stateService.findById(id(place.state), opts, undefined, "code name") : null,
            place.city ? cityService.findById(id(place.city), opts, undefined, "name") : null,
        ]);
        const result: SamePlaces = {};
        if (!country?.code) return result;
        result.country = (await countryService.findOne({company, code: country.code}, opts, undefined, "_id"))?._id;
        if (!result.country) return result;
        if (state) {
            result.state = (await stateService.findOne({company, country: result.country, ...(state.code ? {code: state.code} : {name: state.name})}, opts, undefined, "_id"))?._id;
        }
        if (city) {
            const scope = result.state ? {state: result.state} : {country: result.country};
            result.city = (await cityService.findOne({company, ...scope, name: city.name}, opts, undefined, "_id"))?._id;
        }
        return result;
    });
}
