/**
 * Discovers and runs per-module company demo seed hooks.
 * Each optional module may export `database/companyDemoSeed.ts` with:
 *   - seedCompanyDemoData(logger, company)
 *   - companyDemoSeedOrder (optional number, lower runs first)
 */

import path from "path";
import fs from "fs";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {getEnabledModuleNames, isModuleEnabled} from "@coreModule/utilities/modules/enabledModules";

const SEED_FILENAME = "companyDemoSeed.ts";

type CompanyDemoSeedModule = {
    seedCompanyDemoData?: (logger: serverLogger | undefined, company: any) => Promise<void>;
    companyDemoSeedOrder?: number;
};

export async function runModuleCompanyDemoSeeds(
    parentLogger: serverLogger | undefined,
    company: any,
): Promise<void> {
    const logger = getLogger("module_company_demo_seeds", parentLogger);
    const modulesRoot = path.resolve(__dirname, "../../..");
    const seeds: Array<{moduleName: string; order: number; run: () => Promise<void>}> = [];

    for (const moduleName of getEnabledModuleNames()) {
        if (moduleName === "core" || !isModuleEnabled(moduleName)) {
            continue;
        }

        const seedPath = path.join(modulesRoot, moduleName, "database", SEED_FILENAME);
        if (!fs.existsSync(seedPath)) {
            continue;
        }

        const importPath = seedPath.replace(/\.ts$/, "");
        try {
            const mod = (await import(importPath)) as CompanyDemoSeedModule;
            if (typeof mod.seedCompanyDemoData !== "function") {
                logger.debug(`Skipping ${seedPath} — no seedCompanyDemoData export.`);
                continue;
            }
            seeds.push({
                moduleName,
                order: mod.companyDemoSeedOrder ?? 100,
                run: () => mod.seedCompanyDemoData!(logger, company),
            });
        } catch (error: any) {
            logger.err(`Failed to load company demo seed from ${seedPath}`, error);
        }
    }

    seeds.sort((a, b) => a.order - b.order || a.moduleName.localeCompare(b.moduleName));

    for (const seed of seeds) {
        try {
            logger.debug(`Running company demo seed for [${seed.moduleName}]...`);
            await seed.run();
        } catch (error: any) {
            logger.err(`Company demo seed failed for [${seed.moduleName}]`, error);
        }
    }
}
