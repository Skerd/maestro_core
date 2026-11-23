import type {ObjectId} from "mongodb";

/** Sample companies seen so far. The flag is set when a company is made and never cleared, so a yes never goes stale. */
const knownSandboxes = new Set<string>();

/**
 * Whether `companyId` is a sample company ("Try with sample data", D178). Its records hold demo people's addresses and
 * phone numbers, so core's mail and SMS sends stop here for it. A no is asked again each time: the company may have
 * been made after the last ask.
 */
export async function isSandboxCompany(companyId: ObjectId | string): Promise<boolean> {
    const key = companyId.toString();
    if (knownSandboxes.has(key)) return true;
    // Loaded at call time: the Company model imports the mail service, which asks this.
    const {companyService} = await import("@coreModule/database/schemas/company/company.service");
    const company = await companyService.findById(key, {}, undefined, "isSandbox");
    if (company?.isSandbox !== true) return false;
    knownSandboxes.add(key);
    return true;
}
