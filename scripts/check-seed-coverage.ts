/**
 * Reports which schemas still lack default (seed) data.
 *
 * A schema is "covered" when `modules/<module>/database/schemas/<entity>/<entity>.defaults.ts`
 * exists. Purely runtime/telemetry models are excluded — they are written by the
 * running system, never seeded.
 *
 * Usage (from maestro/):
 *   npx ts-node --transpile-only -r tsconfig-paths/register scripts/check-seed-coverage.ts            # summary + gap list
 *   npx ts-node --transpile-only -r tsconfig-paths/register scripts/check-seed-coverage.ts --strict   # exit 1 when any gap remains
 *   npx ts-node --transpile-only -r tsconfig-paths/register scripts/check-seed-coverage.ts --json     # machine-readable
 *
 * Deliberately filesystem-only: importing the schemas would pull in the whole
 * mongoose/model graph just to count files.
 */

import fs from "fs";
import path from "path";

const MODULES_ROOT = path.resolve(__dirname, "../modules");

/**
 * Models the platform writes at runtime (audit trails, sessions, telemetry, locks,
 * caches, webhook receipts). Seeding them would be meaningless or actively wrong.
 *
 * `cronJob` is seeded by `core/cronjobs/bootstrap/seedPlatformJobs.ts` when the
 * cron server boots — not by company demo data.
 */
const EXCLUDED: Record<string, readonly string[]> = {
    core: [
        "apiAccess",
        "auditLog",
        "cronExecution",
        "cronJob",
        "cronLock",
        "lastChannelReadMessage",
        "loginHistory",
        "performance",
        "shared",
        "userSession",
    ],
    eCommerce: ["posCompanyPosLock", "savedSearch"],
    eCommerceMarketplace: [],
    finance: ["paymentWebhookEvent"],
    musicIndustry: [],
    /*
     * `adCampaignRecipient` is written only by the send engine (every field is
     * SYSTEM_WRITE). `marketingPreference` is a consent record — a seeded row
     * would be fabricated consent, which is exactly the thing that must never
     * be invented. `adCampaign` is deliberately NOT excluded: seeding a demo
     * campaign is a real choice someone may want to make, as long as it is
     * left in `draft` so a fresh init never starts emailing.
     */
    propertyManagement: ["dashboardCache", "adCampaignRecipient", "marketingPreference"],
    swissOutreach: ["pipelineRunLog"],
};

type ModuleReport = {
    module: string;
    covered: string[];
    missing: string[];
    excluded: string[];
};

function listSchemaNames(moduleName: string): string[] {
    const schemasDir = path.join(MODULES_ROOT, moduleName, "database", "schemas");
    if (!fs.existsSync(schemasDir)) {
        return [];
    }
    return fs
        .readdirSync(schemasDir, {withFileTypes: true})
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
}

function hasDefaults(moduleName: string, schemaName: string): boolean {
    const dir = path.join(MODULES_ROOT, moduleName, "database", "schemas", schemaName);
    // `rolePermission.default.ts` predates the plural convention; accept both.
    return (
        fs.existsSync(path.join(dir, `${schemaName}.defaults.ts`)) ||
        fs.existsSync(path.join(dir, `${schemaName}.default.ts`))
    );
}

function listModules(): string[] {
    if (!fs.existsSync(MODULES_ROOT)) {
        throw new Error(`Modules root not found: ${MODULES_ROOT}`);
    }
    return fs
        .readdirSync(MODULES_ROOT, {withFileTypes: true})
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
}

function buildReport(): ModuleReport[] {
    return listModules().map((moduleName) => {
        const excludedForModule = new Set(EXCLUDED[moduleName] ?? []);
        const report: ModuleReport = {module: moduleName, covered: [], missing: [], excluded: []};

        for (const schemaName of listSchemaNames(moduleName)) {
            if (excludedForModule.has(schemaName)) {
                report.excluded.push(schemaName);
            } else if (hasDefaults(moduleName, schemaName)) {
                report.covered.push(schemaName);
            } else {
                report.missing.push(schemaName);
            }
        }

        return report;
    });
}

function hasModuleSeedEntryPoint(moduleName: string): boolean {
    return fs.existsSync(path.join(MODULES_ROOT, moduleName, "database", "companyDemoSeed.ts"));
}

function main(): void {
    const args = process.argv.slice(2);
    const strict = args.includes("--strict");
    const asJson = args.includes("--json");

    const reports = buildReport();

    if (asJson) {
        console.log(JSON.stringify(reports, null, 2));
    } else {
        let totalCovered = 0;
        let totalMissing = 0;

        for (const report of reports) {
            const total = report.covered.length + report.missing.length;
            if (total === 0 && report.excluded.length === 0) {
                continue;
            }
            totalCovered += report.covered.length;
            totalMissing += report.missing.length;

            const entryPoint =
                report.module === "core"
                    ? "n/a (seeded from company.defaults)"
                    : hasModuleSeedEntryPoint(report.module)
                      ? "companyDemoSeed.ts ✓"
                      : "companyDemoSeed.ts MISSING";

            console.log(
                `\n${report.module}: ${report.covered.length}/${total} covered` +
                    ` (${report.excluded.length} excluded) — ${entryPoint}`,
            );
            if (report.missing.length > 0) {
                console.log(`  missing: ${report.missing.join(", ")}`);
            }
        }

        const grandTotal = totalCovered + totalMissing;
        console.log(
            `\nTOTAL: ${totalCovered}/${grandTotal} schemas have defaults` +
                ` (${totalMissing} remaining).`,
        );
    }

    if (strict && reports.some((report) => report.missing.length > 0)) {
        process.exit(1);
    }
}

main();
