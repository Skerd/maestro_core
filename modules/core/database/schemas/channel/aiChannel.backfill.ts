/**
 * One-time backfill: ensure every existing company has an AI bot user and that
 * every non-bot company-role user has their single AI-assistant channel.
 *
 * Idempotent - safe to run repeatedly. `createBot` no-ops when a bot already
 * exists, and `ensureAiChannels` get-or-creates one channel per user. Run this
 * once after deploying the AI-channel feature (e.g. from the startup/seed runner
 * or a maintenance script) so companies created before the feature are covered.
 *
 * Requires an active mongoose connection.
 */

import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import Company from "@coreModule/database/schemas/company/company";

export async function backfillAiChannels(parentLogger?: serverLogger): Promise<void> {
    const logger = getLogger("backfill_ai_channels", parentLogger);
    logger.start("Backfilling AI-assistant channels for all companies...");

    const companies = await Company.find({});
    logger.debug(`Found ${companies.length} company(ies) to process`);

    let ok = 0;
    let failed = 0;
    for (const company of companies) {
        try {
            await company.createBot();        // idempotent: creates the bot only if missing
            await company.ensureAiChannels();  // idempotent: one channel per non-bot role user
            ok++;
            logger.debug(`Ensured AI channels for company '${company.name}' (${company._id.toString()})`);
        } catch (e) {
            failed++;
            logger.err(`Failed AI-channel backfill for company ${company._id.toString()}: ${e}`);
        }
    }

    logger.finish(`Finished AI-channel backfill! Succeeded: ${ok}, failed: ${failed}.`);
}
