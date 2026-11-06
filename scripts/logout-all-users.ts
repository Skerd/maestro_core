/**
 * Revoke every active UserSession so existing JWTs fail auth on the next request.
 *
 * Matches UserSessionActions.revoke / currentRevoke: sets isActive = false.
 * Auth middleware and websocket both call validateActiveUserSession, which
 * requires isActive: true. Users can log in again afterwards (a new session).
 *
 * Usage (from maestro/):
 *   npx ts-node --transpile-only -r tsconfig-paths/register scripts/logout-all-users.ts --dry-run
 *   npx ts-node --transpile-only -r tsconfig-paths/register scripts/logout-all-users.ts --yes
 *   npx ts-node --transpile-only -r tsconfig-paths/register scripts/logout-all-users.ts --yes --company-id=<ObjectId>
 */

import {ObjectId} from "mongodb";
import {connectToMongoDb, mongooseInstance} from "@coreModule/connections/connectToMongoDb";
import {asCrossTenant} from "@coreModule/utilities/endpoints/tenantScope";
import Company from "@coreModule/database/schemas/company/company";
import UserSession from "@coreModule/database/schemas/userSession/userSession";

type CliOptions = {
    dryRun: boolean;
    yes: boolean;
    companyId: string | null;
};

function parseArgs(): CliOptions {
    const options: CliOptions = {dryRun: false, yes: false, companyId: null};
    for (const arg of process.argv.slice(2)) {
        if (arg === "--dry-run") options.dryRun = true;
        else if (arg === "--yes") options.yes = true;
        else if (arg.startsWith("--company-id=")) options.companyId = arg.split("=")[1];
    }
    return options;
}

function printUsage(): void {
    console.log(`Usage (from maestro/):
  npx ts-node --transpile-only -r tsconfig-paths/register scripts/logout-all-users.ts --dry-run
  npx ts-node --transpile-only -r tsconfig-paths/register scripts/logout-all-users.ts --yes
  npx ts-node --transpile-only -r tsconfig-paths/register scripts/logout-all-users.ts --yes --company-id=<ObjectId>

  --dry-run       Count matching sessions, do not write
  --yes           Required to actually revoke (skips confirmation)
  --company-id    Limit to one company
`);
}

async function main(): Promise<void> {
    const options = parseArgs();
    if (!options.dryRun && !options.yes) {
        printUsage();
        console.error("Refusing to revoke sessions without --yes (or pass --dry-run to preview).");
        process.exit(1);
    }

    await connectToMongoDb(undefined, false);

    const filter: Record<string, unknown> = {isActive: true};
    if (options.companyId) {
        if (!ObjectId.isValid(options.companyId)) {
            console.error(`Invalid --company-id: ${options.companyId}`);
            process.exit(1);
        }
        const company = await Company.findById(options.companyId).select("_id name");
        if (!company) {
            console.error(`Company ${options.companyId} not found`);
            process.exit(1);
        }
        filter.company = company._id;
        console.log(`Scope: company ${company.name} (${company._id})`);
    } else {
        console.log("Scope: all companies");
    }

    const [sessionCount, userIds, companyIds] = await Promise.all([
        UserSession.countDocuments(filter),
        UserSession.distinct("user", filter),
        UserSession.distinct("company", filter),
    ]);

    console.log(`Active sessions: ${sessionCount}`);
    console.log(`Distinct users:  ${userIds.length}`);
    console.log(`Distinct companies: ${companyIds.length}`);

    if (options.dryRun) {
        console.log("[dry-run] No sessions revoked.");
        return;
    }

    const result = await UserSession.updateMany(filter, {$set: {isActive: false}});
    console.log(`Revoked ${result.modifiedCount} session(s). Users must log in again.`);
}

if (require.main === module) {
    // Operator scripts span companies on purpose (D16).
    asCrossTenant("an operator logout ends every company's sessions", main)
        .then(async () => {
            await mongooseInstance.disconnect();
            process.exit(0);
        })
        .catch(async (error) => {
            console.error("logout-all-users failed:", error);
            try {
                await mongooseInstance.disconnect();
            } catch {
                /* ignore */
            }
            process.exit(1);
        });
}
