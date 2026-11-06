/**
 * Non-destructive rehearsal of the full init seed chain.
 *
 * Runs `createRolePermissions → createUsers → createCompanies(demoData)` against a
 * *scratch* database and prints what landed, so the defaults can be exercised without
 * dropping the dev database. It refuses to run unless the connected database name
 * contains "seedtest".
 *
 * Usage (from maestro/):
 *   MONGODB_DB_NAME=xCloud-Pronix-seedtest npx ts-node --transpile-only -r tsconfig-paths/register scripts/rehearse-seeds.ts
 *
 * Note this deliberately skips `dropAll()` — it seeds into whatever is there, which
 * doubles as the idempotency check when run twice against the same scratch database.
 */

import {connectToMongoDb, mongooseInstance} from "@coreModule/connections/connectToMongoDb";
import {asCrossTenant} from "@coreModule/utilities/endpoints/tenantScope";
import {getLogger} from "@coreModule/loggers/serverLog";
import {createRolePermissions} from "@coreModule/database/schemas/rolePermission/rolePermission.default";
import {createUsers} from "@coreModule/database/schemas/user/user.defaults";
import {createCompanies} from "@coreModule/database/schemas/company/company.defaults";

async function main(): Promise<void> {
    const logger = getLogger("seed_rehearsal");
    await connectToMongoDb(undefined, false);

    const dbName = mongooseInstance.connection.db.databaseName;
    if (!dbName.includes("seedtest")) {
        console.error(
            `REFUSING: connected to "${dbName}". Set MONGODB_DB_NAME to a *seedtest* database first.`,
        );
        process.exit(2);
    }
    console.log(`Rehearsing seeds against ${dbName}\n`);

    await createRolePermissions(logger);
    await createUsers(logger);
    await createCompanies(logger, true);

    const db = mongooseInstance.connection.db;
    const names = (await db.listCollections().toArray())
        .map((c: {name: string}) => c.name)
        .filter((name: string) => !name.startsWith("system."))
        .sort();

    const counts: Record<string, number> = {};
    const empty: string[] = [];
    for (const name of names) {
        const total = await db.collection(name).countDocuments({});
        if (total > 0) counts[name] = total;
        else empty.push(name);
    }

    console.log("\n=== COLLECTIONS WITH DATA ===");
    console.log(JSON.stringify(counts, null, 1));

    if (empty.length > 0) {
        console.log(`\n=== EMPTY COLLECTIONS (${empty.length}) ===`);
        console.log(empty.join(", "));
    }

    const unitStatus = await db
        .collection("units")
        .aggregate([{$group: {_id: "$status", n: {$sum: 1}}}, {$sort: {_id: 1}}])
        .toArray();
    console.log("\n=== UNIT STATUS ===");
    console.log(JSON.stringify(unitStatus));

    await mongooseInstance.connection.close();
    process.exit(0);
}

// Operator scripts span companies on purpose (D16).

asCrossTenant("a seed rehearsal writes every company's demo data", main).catch((e) => {
    console.error(e);
    process.exit(1);
});
