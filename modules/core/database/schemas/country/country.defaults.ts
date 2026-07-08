import Country from "@coreModule/database/schemas/country/country";
import {EUROPE_AND_BALKANS_ISO_CODES} from "@coreModule/database/schemas/country/europeAndBalkansIsoCodes";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {Country as CountryList} from "country-state-city";
import {ICompany} from "@coreModule/database/schemas/company/company";
import Currency from "@coreModule/database/schemas/currency/currency";

export async function createCountries(parentLogger: serverLogger, company: ICompany) {
    const logger = getLogger("mongoDbInitialization-createCountries", parentLogger);
    logger.start("Creating countries...");

    try {
        const countries = CountryList.getAllCountries().filter((c) => EUROPE_AND_BALKANS_ISO_CODES.has(c.isoCode));
        const countryCodes = countries.map((country) => country.isoCode);
        const alreadyInsertedCountries = (await Country.find({code: {$in: countryCodes}, company: company}).select("code").lean())!.map((country) => country.code);
        const countriesToInsert = countries.filter((country) => !alreadyInsertedCountries.includes(country.isoCode));

        const bulkCountryInsert = [];
        const countriesInserted = [];

        for (const country of countriesToInsert) {
            bulkCountryInsert.push(new Country({
                name: country.name,
                code: country.isoCode,
                phoneCode: country.phonecode,
                company: company,
                createdBy: company.createdBy
            }));
            countriesInserted.push(country.name);
        }

        if (bulkCountryInsert.length > 0) {
            await Country.bulkSave(bulkCountryInsert);
            logger.debug(`Successfully inserted ${countriesInserted.length} countries.`);
        } else {
            logger.debug("All countries already exist.");
        }

        logger.finish("Finished creating countries!");
    } catch (err: any) {
        logger.err(`Error while creating countries: ${err.message}`);
        logger.fail("Failed to create countries!");
    }
}
