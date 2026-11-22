/**
 * Runs the upload content check (D177) over files stored before it existed, every company's. Flag only: a clear case
 * is flagged (blurred for staff, not sent to visitors), never deleted.
 *
 *   npm run media:moderate-existing                       videos (the default)
 *   npm run media:moderate-existing -- --types=video,image,pdf,document
 *   npm run media:moderate-existing -- --dry-run          report only, write nothing
 */

import {connectToMongoDb, mongooseInstance} from "@coreModule/connections/connectToMongoDb";
import {asCrossTenant} from "@coreModule/utilities/endpoints/tenantScope";
import {getLogger} from "@coreModule/loggers/serverLog";
import {LocalContentModerator} from "@coreModule/utilities/security/contentModerator";
import {moderateExistingMedia} from "@coreModule/utilities/media/moderateExistingMedia";

const MEDIA_KINDS = ["image", "video", "pdf", "document"] as const;
type MediaKind = (typeof MEDIA_KINDS)[number];

function requestedTypes(): MediaKind[] {
    const value = process.argv.find(arg => arg.startsWith("--types="))?.slice("--types=".length) ?? "video";
    const types = value.split(",").map(type => type.trim());
    const unknown = types.filter(type => !MEDIA_KINDS.some(kind => kind === type));
    if (unknown.length) throw new Error(`Unknown --types: ${unknown.join(", ")} (use image, video, pdf, document)`);
    return MEDIA_KINDS.filter(kind => types.includes(kind));
}

async function main(): Promise<void> {
    const types = requestedTypes();
    const dryRun = process.argv.includes("--dry-run");
    await connectToMongoDb(undefined, false);
    const result = await moderateExistingMedia({moderator: new LocalContentModerator(), types, logger: getLogger("moderate_existing_media"), dryRun});
    console.log(`${dryRun ? "[dry run] " : ""}Checked ${result.checked} ${types.join(" and ")} file(s): ${result.passed} passed, ${result.flagged} flagged, ${result.notChecked} could not be checked.`);
    if (result.flaggedIds.length) console.log(`Flagged: ${result.flaggedIds.join(" ")}`);
}

if (require.main === module) {
    asCrossTenant("the content check of stored files covers every company", main)
        .then(async () => {
            await mongooseInstance.disconnect();
            process.exit(0);
        })
        .catch(async (error) => {
            console.error("moderateExistingMedia failed:", error instanceof Error ? error.message : error);
            try {
                await mongooseInstance.disconnect();
            } catch {
                /* ignore */
            }
            process.exit(1);
        });
}
