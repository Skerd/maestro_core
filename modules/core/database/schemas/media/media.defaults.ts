import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {ICompany} from "@coreModule/database/schemas/company/company";

/**
 * Core `Media` has no standalone demo rows. Binaries are seeded by the modules
 * that own them (property-management hierarchy, marketplace listings). This
 * file exists so the coverage checker treats the schema as covered rather than
 * inventing orphan GridFS blobs.
 */
export async function createMedia(
    parentLogger: serverLogger,
    _company: ICompany,
): Promise<void> {
    const logger = getLogger("mongoDbInitialization-createMedia", parentLogger);
    logger.start("Skipping standalone media — binaries are seeded by owning modules.");
    logger.finish("Finished media defaults (no standalone rows).", 0);
}
