import {Decimal128} from "mongodb";
import Finance from "./finance";
import Currency from "@coreModule/database/schemas/currency/currency";
import User from "@coreModule/database/schemas/user/user";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {ICompany} from "@coreModule/database/schemas/company/company";

/**
 * Ensures every company user has a wallet with the seeded currencies.
 *
 * Creator wallets are already minted in `assignCreatorFinanceAndRoles`; this
 * pass fills the gap for the other demo users without overwriting existing
 * balances on a re-run.
 */
export async function createFinances(
    parentLogger: serverLogger,
    company: ICompany,
): Promise<void> {
    const logger = getLogger("mongoDbInitialization-createFinances", parentLogger);
    logger.start("Ensuring user finance wallets...");

    try {
        const currencies = await Currency.find({}).select("_id");
        if (currencies.length === 0) {
            logger.warn("Skipping finance wallets: no currencies seeded.");
            logger.finish("Finished ensuring user finance wallets!", 0);
            return;
        }

        const users = await User.find({companies: company._id}).select("_id finance");
        let created = 0;

        for (const user of users) {
            if (Array.isArray(user.finance) && user.finance.length > 0) {
                continue;
            }

            const wallet = await Finance.create({
                currencies: currencies.map((currency) => ({
                    currency: currency._id,
                    amount: Decimal128.fromString("0"),
                })),
                company: company._id,
                createdBy: company.createdBy,
            });

            user.finance = [wallet._id];
            await user.save();
            created += 1;
        }

        logger.finish("Finished ensuring user finance wallets!", created);
    } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        logger.err(`Error ensuring finance wallets: ${message}`);
        logger.fail("Failed to ensure finance wallets!");
    }
}
