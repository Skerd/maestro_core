/**
 * Master-key rotation for health data at rest (D102): rewraps every company's data keys under the current
 * HEALTH_DATA_MASTER_KEY, opening the ones still wrapped by HEALTH_DATA_MASTER_KEY_PREVIOUS. The encrypted records and
 * files are not touched: they are sealed with the data keys, which stay the same.
 *
 * Usage (from maestro/, with the new key in HEALTH_DATA_MASTER_KEY and the old one in HEALTH_DATA_MASTER_KEY_PREVIOUS,
 * the same values the running servers use):
 *   npm run health:rewrap-keys
 * Once it succeeds (a second run rewraps 0), remove HEALTH_DATA_MASTER_KEY_PREVIOUS and restart the servers.
 */

import {connectToMongoDb, mongooseInstance} from "@coreModule/connections/connectToMongoDb";
import {asCrossTenant} from "@coreModule/utilities/endpoints/tenantScope";
import {rewrapCompanyDataKeys} from "@coreModule/utilities/security/healthDataCrypto";

async function main(): Promise<void> {
    await connectToMongoDb(undefined, false);
    const rewrapped = await rewrapCompanyDataKeys();
    console.log(`Rewrapped ${rewrapped} company data key(s) under the current master key.`);
}

if (require.main === module) {
    // A rotation covers every company's keys (D16).
    asCrossTenant("a master-key rotation rewraps every company's health data keys", main)
        .then(async () => {
            await mongooseInstance.disconnect();
            process.exit(0);
        })
        .catch(async (error) => {
            console.error("rewrapHealthDataKeys failed:", error instanceof Error ? error.message : error);
            try {
                await mongooseInstance.disconnect();
            } catch {
                /* ignore */
            }
            process.exit(1);
        });
}
