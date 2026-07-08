import City from "@coreModule/database/schemas/city/city";
import Country from "@coreModule/database/schemas/country/country";
import State from "@coreModule/database/schemas/state/state";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {City as CityList} from "country-state-city";
import {ICompany} from "@coreModule/database/schemas/company/company";
import {Types} from "mongoose";

const INSERT_BATCH_SIZE = 10000;

export async function createCities(parentLogger: serverLogger, company: ICompany) {
    const logger = getLogger("mongoDbInitialization-createCities", parentLogger);
    logger.start("Creating cities...");

    try {
        const [allCountries, allStates, existingCities] = await Promise.all([
            Country.find({company}).select("_id code").lean(),
            State.find({company}).select("_id code country").lean(),
            City.find({company}).select("state name").lean(),
        ]);

        const statesByCountryId = new Map<string, typeof allStates>();
        for (const state of allStates) {
            const countryId = (state.country as any).toString?.() ?? state.country;
            if (!statesByCountryId.has(countryId)) statesByCountryId.set(countryId, []);
            statesByCountryId.get(countryId)!.push(state);
        }

        const existingKeySet = new Set(
            existingCities.map((city) => `${(city.state as any).toString?.() ?? city.state}|${city.name}`)
        );

        const companyId = (company as any)._id ?? company.id;
        const createdBy = (company as ICompany & {createdBy?: Types.ObjectId}).createdBy;
        const docs: Array<{name: string; state: Types.ObjectId; country: Types.ObjectId; company: Types.ObjectId; createdBy?: Types.ObjectId}> = [];

        for (const country of allCountries) {
            const countryId = country._id.toString();
            const states = statesByCountryId.get(countryId) ?? [];

            for (const state of states) {
                const cities = CityList.getCitiesOfState(country.code, state.code ?? "");
                for (const city of cities) {
                    const key = `${state._id}|${city.name}`;
                    if (existingKeySet.has(key)) continue;

                    existingKeySet.add(key);
                    docs.push({
                        name: city.name,
                        state: state._id,
                        country: country._id,
                        company: companyId,
                        createdBy,
                    });
                }
            }
        }

        if (docs.length > 0) {
            for (let i = 0; i < docs.length; i += INSERT_BATCH_SIZE) {
                const chunk = docs.slice(i, i + INSERT_BATCH_SIZE);
                await City.insertMany(chunk, {ordered: false});
                if (docs.length > INSERT_BATCH_SIZE) {
                    logger.debug(`Inserted cities ${i + chunk.length}/${docs.length}.`);
                }
            }
            logger.debug(`Successfully inserted ${docs.length} cities.`);
        } else {
            logger.debug("All cities already exist.");
        }

        logger.finish("Finished creating cities!");
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.err(`Error while creating cities: ${message}`);
        logger.fail("Failed to create cities!");
    }
}
