import {Decimal128} from "mongodb";
import Transaction, {TransactionStatus, TransactionType} from "./transaction";
import User from "@coreModule/database/schemas/user/user";
import Currency from "@coreModule/database/schemas/currency/currency";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {ICompany} from "@coreModule/database/schemas/company/company";

/**
 * One completed bonus transfer into the main demo user so the wallet ledger
 * is not empty. There is no notes field, so idempotency keys on
 * `{company, type: BONUS, sender, receiver}` — a company only ever gets this
 * one seeded bonus.
 */
export async function createTransactions(
    parentLogger: serverLogger,
    company: ICompany,
): Promise<void> {
    const logger = getLogger("mongoDbInitialization-createTransactions", parentLogger);
    logger.start("Creating demo wallet transactions...");

    try {
        const echo = await User.findOne({username: "echo@echo.com"}).select("_id finance");
        const almir = await User.findOne({username: "almir@leka.com"}).select("_id finance");
        const currency = await Currency.findOne({abbreviation: "EUR"}).select("_id");
        if (!echo || !almir || !currency) {
            logger.warn("Skipping wallet transaction: echo, almir or EUR missing.");
            logger.finish("Finished creating demo wallet transactions!", 0);
            return;
        }

        const payload = {
            amount: Decimal128.fromString("100"),
            currency: currency._id,
            sender: echo._id,
            receiver: almir._id,
            senderFinance: echo.finance?.[0],
            receiverFinance: almir.finance?.[0],
            date: new Date(),
            status: TransactionStatus.COMPLETED,
            type: TransactionType.BONUS,
            company: company._id,
            createdBy: echo._id,
        };

        const existing = await Transaction.findOne({
            company: company._id,
            type: TransactionType.BONUS,
            sender: echo._id,
            receiver: almir._id,
        });
        if (existing) {
            existing.set(payload);
            await existing.save();
        } else {
            await Transaction.create(payload);
        }

        logger.finish("Finished creating demo wallet transactions!", 1);
    } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        logger.err(`Error creating demo wallet transaction: ${message}`);
        logger.fail("Failed to create demo wallet transactions!");
    }
}
