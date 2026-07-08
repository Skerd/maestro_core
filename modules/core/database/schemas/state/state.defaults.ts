import State from "@coreModule/database/schemas/state/state";
import Country from "@coreModule/database/schemas/country/country";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {City as CityList, State as StateList} from "country-state-city";
import {ICompany} from "@coreModule/database/schemas/company/company";

export async function createStates(parentLogger: serverLogger, company: ICompany) {
    const logger = getLogger("mongoDbInitialization-createStates", parentLogger);
    logger.start("Creating states...");

    try {
        const bulkStateInsert = [];
        const allCountries = await Country.find({company}).select("code").lean();

        for (const country of allCountries) {
            const states = StateList.getStatesOfCountry(country.code).filter(
                (state) => CityList.getCitiesOfState(country.code, state.isoCode).length > 0
            );
            const stateCodes = states.map((state) => state.isoCode);
            const alreadyInsertedStates = (
                await State.find({country: country._id, code: {$in: stateCodes}, company}).select("code").lean()
            ).map((state) => state.code);
            const statesToInsert = states.filter((state) => !alreadyInsertedStates.includes(state.isoCode));

            for (const state of statesToInsert) {
                bulkStateInsert.push(
                    new State({
                        name: state.name,
                        code: state.isoCode,
                        country: country._id,
                        company,
                        createdBy: company.createdBy
                    })
                );
            }
        }

        if (bulkStateInsert.length > 0) {
            await State.bulkSave(bulkStateInsert);
            logger.debug(`Successfully inserted ${bulkStateInsert.length} states.`);
        } else {
            logger.debug("All states already exist.");
        }

        logger.finish("Finished creating states!");
    } catch (err: any) {
        logger.err(`Error while creating states: ${err.message}`);
        logger.fail("Failed to create states!");
    }
}
