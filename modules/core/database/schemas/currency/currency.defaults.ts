import Currency from "@coreModule/database/schemas/currency/currency";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {ICompany} from "@coreModule/database/schemas/company/company";

const currencyCodes = require("currency-codes");
const getSymbolFromCurrency = require("currency-symbol-map");

const SEED_CURRENCY_CODE = "EUR";

export async function createCurrencies(parentLogger: serverLogger, company: ICompany) {
    const logger = getLogger("mongoDbInitialization-createCurrencies", parentLogger);
    logger.start("Creating currencies...");

    const eur = currencyCodes.code(SEED_CURRENCY_CODE);
    if (!eur) {
        logger.fail(`Currency code '${SEED_CURRENCY_CODE}' not found in currency-codes`);
        return;
    }

    const currencies = [{
        name: eur.currency,
        symbol: getSymbolFromCurrency(eur.code) || "€",
        decimalPlaces: eur.digits ?? 2,
        abbreviation: eur.code,
    }];

    for (const currency of currencies) {
        try {
            const result = await Currency.updateOne(
                {
                    abbreviation: currency.abbreviation,
                    company: company._id,
                },
                {
                    $set: {
                        name: currency.name,
                        symbol: currency.symbol,
                        decimalPlaces: currency.decimalPlaces,
                    },
                    $setOnInsert: {
                        company: company._id,
                        createdBy: company.createdBy,
                    },
                },
                {upsert: true}
            );

            if (result.upsertedCount > 0) {
                logger.info(`Successfully created currency '${currency.name}'`);
            } else {
                logger.info(`Currency '${currency.name}' already exists. Updated [symbol, decimalPlaces]`);
            }
        } catch (e: any) {
            logger.err(`Error creating currency '${currency.name}': ${e.message}`);
        }
    }

    logger.finish("Finished creating currencies!", currencies.length);
}
