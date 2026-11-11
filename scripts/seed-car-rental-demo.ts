/**
 * One-shot: seed car rental demo data (fleet, bookings in every status, papers, damages, fines and transfers in
 * every state, and today's counter work) for the demo rental company without dropping the database. Every row is
 * keyed, so re-running adds only what is new: on a later day, that day's pickups and returns.
 *
 * Usage (from maestro/):
 *   MONGODB_DB_NAME=xCloud-all npx ts-node --transpile-only -r tsconfig-paths/register scripts/seed-car-rental-demo.ts
 */

process.env.ENABLED_MODULES = process.env.ENABLED_MODULES || "carRental";

import mongoose from "mongoose";
import {connectToMongoDb} from "@coreModule/connections/connectToMongoDb";
import {asCrossTenant} from "@coreModule/utilities/endpoints/tenantScope";
import Company from "@coreModule/database/schemas/company/company";
import {getLogger} from "@coreModule/loggers/serverLog";
import {seedCarRentalDemoData} from "@carRentalModule/database/demo/carRentalCompanyDemo";

async function main() {
    const logger = getLogger("seed_car_rental_demo");
    logger.start("Connecting and seeding car rental demo data...");

    await connectToMongoDb(logger, false);

    // By VAT only: the demo rental company is renamed in the panel (e.g. "Adriatic Drive").
    const company = await Company.findOne({vat: "Z323456789Z"});
    if (!company) {
        throw new Error("Car rental demo company (VAT Z323456789Z) not found — cannot seed.");
    }

    logger.info(`Seeding against company ${company.name} (${company._id})`);
    await seedCarRentalDemoData(logger, company);
    logger.finish("Car rental demo seed complete.");
    await mongoose.disconnect();
    process.exit(0);
}

// Operator scripts span companies on purpose (D16).

asCrossTenant("a demo seed writes the rental company's data", main).catch(async (err) => {
    console.error(err);
    try {
        await mongoose.disconnect();
    } catch {
        /* ignore */
    }
    process.exit(1);
});
