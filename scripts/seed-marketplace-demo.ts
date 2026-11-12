/**
 * One-shot: seed the services marketplace demo data (settings listed on the portal, listings with packages and
 * add-ons, task requests and bids, orders with deliveries, revisions and milestones, bookings, disputes, reviews,
 * promotions, and the escrow ledger rows) for the demo marketplace company without dropping the database. Every row is
 * keyed, so re-running adds only what is new.
 *
 * Usage (from maestro/):
 *   MONGODB_DB_NAME=xCloud-all npx ts-node --transpile-only -r tsconfig-paths/register scripts/seed-marketplace-demo.ts
 */

// The marketplace depends on finance (escrow ledger); the manifest adds it.
process.env.ENABLED_MODULES = process.env.ENABLED_MODULES || "marketplace";

import mongoose from "mongoose";
import {connectToMongoDb} from "@coreModule/connections/connectToMongoDb";
import {asCrossTenant} from "@coreModule/utilities/endpoints/tenantScope";
import Company from "@coreModule/database/schemas/company/company";
import {getLogger} from "@coreModule/loggers/serverLog";
import {seedCompanyDemoData} from "@marketplaceModule/database/companyDemoSeed";

async function main() {
    const logger = getLogger("seed_marketplace_demo");
    logger.start("Connecting and seeding marketplace demo data...");

    await connectToMongoDb(logger, false);

    // By VAT only: the demo marketplace company may be renamed in the panel (e.g. "Tirana Pros").
    const company = await Company.findOne({vat: "Z523456789Z"});
    if (!company) {
        throw new Error("Marketplace demo company (VAT Z523456789Z) not found — run sync:demo-companies first.");
    }

    logger.info(`Seeding against company ${company.name} (${company._id})`);
    await seedCompanyDemoData(logger, company);
    logger.finish("Marketplace demo seed complete.");
    await mongoose.disconnect();
    process.exit(0);
}

// Operator scripts span companies on purpose (D16).
asCrossTenant("a demo seed writes the marketplace company's data", main).catch(async (err) => {
    console.error(err);
    try {
        await mongoose.disconnect();
    } catch {
        /* ignore */
    }
    process.exit(1);
});
