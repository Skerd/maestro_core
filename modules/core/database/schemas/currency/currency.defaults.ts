import Currency from "@coreModule/database/schemas/currency/currency";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {ICompany} from "@coreModule/database/schemas/company/company";

const currencyCodes = require("currency-codes");
const getSymbolFromCurrency = require("currency-symbol-map");

const SEED_CURRENCY_CODES = ["EUR", "CHF"];
const FALLBACK_SYMBOLS: Record<string, string> = {EUR: "€", CHF: "CHF"};

export async function createCurrencies(parentLogger: serverLogger, company: ICompany) {
    const logger = getLogger("mongoDbInitialization-createCurrencies", parentLogger);
    logger.start("Creating currencies...");

    const currencies = [];
    for (const code of SEED_CURRENCY_CODES) {
        const meta = currencyCodes.code(code);
        if (!meta) {
            logger.fail(`Currency code '${code}' not found in currency-codes`);
            continue;
        }
        currencies.push({
            name: meta.currency,
            symbol: getSymbolFromCurrency(meta.code) || FALLBACK_SYMBOLS[code] || meta.code,
            decimalPlaces: meta.digits ?? 2,
            abbreviation: meta.code,
        });
    }

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
