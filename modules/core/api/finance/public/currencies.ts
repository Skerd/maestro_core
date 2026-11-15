import {Router} from "express";
import authMW, {NotAuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import {asyncHandler} from "@coreModule/utilities/middlewares/asyncHandler";
import {rateLimiter} from "@coreModule/utilities/middlewares/rateLimiter";
import {resolveCompanyByOrigin} from "@coreModule/utilities/marketing/resolveCompanyByOrigin";
import {currencyService} from "@coreModule/database/schemas/currency/currency.service";
import {platformRowsClause} from "@coreModule/utilities/security/platformAccess";
import type {PublicCurrenciesResponseType} from "armonia/src/modules/core/api/finance/public/currencies/publicCurrencies.response.type";

const router = Router();

type PublicCurrenciesParams = NotAuthenticatedMWType;

router.get(
    "",
    authMW("public"),
    rateLimiter({windowMs: 60000, max: 60}),
    asyncHandler(listPublicCurrencies),
);

async function listPublicCurrencies(
    params: PublicCurrenciesParams,
): Promise<PublicCurrenciesResponseType> {
    const {origin, languageCode, logger} = params;
    logger.start("Listing public currencies...");

    // The origin must still name a known site (fails closed); the list itself is the platform's (D160).
    const company = await resolveCompanyByOrigin(origin, languageCode);
    let currencies = await currencyService.find(
        await platformRowsClause(),
        {logger, languageCode},
        undefined,
        ["name", "symbol", "abbreviation"],
        {abbreviation: 1},
    );

    const data = currencies.map((currency) => ({
        _id: currency._id.toString(),
        name: currency.name,
        symbol: currency.symbol,
        abbreviation: currency.abbreviation,
    }));

    logger.finish(`Listed ${data.length} public currencies for ${company.name}`);
    return {data};
}

export const basePath = "/api/finance/public/currencies";
module.exports = {router, basePath};
