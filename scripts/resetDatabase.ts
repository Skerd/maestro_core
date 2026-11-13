/**
 * Drops and re-seeds the configured database through the normal init chain
 * (`initializeMongoDatabase`: dropAll → roles → users → companies + module demo seeds).
 *
 * Run it through the dev launcher, which sets the profile env and the guard:
 *   npm run dev -- reset <profile>          (from the repo root)
 *
 * It refuses to run unless `ARPEGGIO_RESET_DB` names the connected database, so a
 * stray `MONGODB_INIT=true` in a shell can never wipe the wrong one.
 */

process.env.MONGODB_INIT = "true";

import {connectToMongoDb, mongooseInstance} from "@coreModule/connections/connectToMongoDb";
import {getLogger} from "@coreModule/loggers/serverLog";
import {MONGO_DB} from "@coreModule/environment";
import {loadModuleExceptionLocales} from "@coreModule/utilities/helpers/exceptionLocales";

async function main(): Promise<void> {
    if (!process.env.ARPEGGIO_RESET_DB || process.env.ARPEGGIO_RESET_DB !== MONGO_DB.DB_NAME) {
        console.error(`REFUSING: ARPEGGIO_RESET_DB must equal MONGODB_DB_NAME ("${MONGO_DB.DB_NAME}").`);
        process.exit(2);
    }

    // The modules' API errors, registered as the servers do, so a seed step the API refuses logs its message.
    loadModuleExceptionLocales();
    const logger = getLogger("reset_database");
    await connectToMongoDb(logger, true);

    const db = mongooseInstance.connection.db;
    const counts: Record<string, number> = {};
    for (const {name} of await db.listCollections().toArray()) {
        if (name.startsWith("system.")) continue;
        const total = await db.collection(name).countDocuments({});
        if (total > 0) counts[name] = total;
    }
    console.log(`\n=== ${db.databaseName}: COLLECTIONS WITH DATA ===`);
    console.log(JSON.stringify(counts, null, 1));

    await mongooseInstance.connection.close();
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
