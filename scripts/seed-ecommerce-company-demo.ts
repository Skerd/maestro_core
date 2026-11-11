/**
 * One-shot: seed the eCommerce demo data (catalog, orders, till, stock) for the demo shop without dropping the
 * database, including a record in every state of returns, till shifts and sales, stock movements, counts and
 * transfers. Every row is keyed, so re-running adds only what is new.
 *
 * Usage (from maestro/):
 *   MONGODB_DB_NAME=xCloud-all npx ts-node --transpile-only -r tsconfig-paths/register scripts/seed-ecommerce-company-demo.ts
 */

// eCommerce depends on finance (fiscal config, payment ledger); the manifest adds it.
process.env.ENABLED_MODULES = process.env.ENABLED_MODULES || "eCommerce";

import mongoose from "mongoose";
import {connectToMongoDb} from "@coreModule/connections/connectToMongoDb";
import {asCrossTenant} from "@coreModule/utilities/endpoints/tenantScope";
import Company from "@coreModule/database/schemas/company/company";
import {getLogger} from "@coreModule/loggers/serverLog";
import {seedECommerceDemoData} from "@eCommerceModule/database/demo/eCommerceCompanyDemo";

async function main() {
    const logger = getLogger("seed_ecommerce_demo");
    logger.start("Connecting and seeding eCommerce demo data...");

    await connectToMongoDb(logger, false);

    // By VAT only: the demo shop is renamed in the panel (e.g. "Arpeggio Market").
    const company = await Company.findOne({vat: "Z123456789Z"});
    if (!company) {
        throw new Error("eCommerce demo company (VAT Z123456789Z) not found — cannot seed.");
    }

    logger.info(`Seeding against company ${company.name} (${company._id})`);
    const result = await seedECommerceDemoData(logger, company);
    if (!result) {
        throw new Error("eCommerce demo seed failed (see the log above).");
    }
    logger.finish("eCommerce demo seed complete.");
    await mongoose.disconnect();
    process.exit(0);
}

// Operator scripts span companies on purpose (D16).

asCrossTenant("a demo seed writes the shop company's data", main).catch(async (err) => {
    console.error(err);
    try {
        await mongoose.disconnect();
    } catch {
        /* ignore */
    }
    process.exit(1);
});
