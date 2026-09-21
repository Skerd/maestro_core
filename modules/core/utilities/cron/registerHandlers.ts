/**
 * Core platform cron handlers.
 *
 * Auto-discovered by {@link module:loadAllCronHandlers}, which scans
 * `{module}/utilities/cron/` for `register*CronHandlers` exports.
 */

import {ObjectId} from "mongodb";
import {registerCronHandler} from "@coreModule/cronjobs/registry/handlerRegistry";
import {runPublicChatRetention} from "@coreModule/utilities/cronJobs/publicChatRetentionJob";
import {runOrphanUploadCleanup} from "@coreModule/utilities/cronJobs/orphanUploadCleanupJob";

export function registerCorePlatformCronHandlers(): void {
    registerCronHandler({
        code: "core.publicChatRetention",
        handler: async ctx => {
            await runPublicChatRetention(ctx.logger);
        },
        version: "1",
        defaultJob: {
            // Nightly and off-peak: the sweep is batched and never urgent.
            name: "Public chat retention sweep",
            cronExpression: "0 30 3 * * *",
            priority: 40,
        },
    });

    registerCronHandler({
        code: "core.orphanUploadCleanup",
        handler: async ctx => {
            if (!ctx.company) {
                ctx.appendLog("skipped: job has no company");
                return;
            }
            const result = await runOrphanUploadCleanup(new ObjectId(ctx.company.toString()), ctx.logger, {signal: ctx.signal});
            ctx.appendLog(
                `examined ${result.examined}, in use ${result.claimed}, deleted ${result.deleted}, failed ${result.failed}`,
            );
        },
        version: "1",
        defaultJob: {
            // Nightly, after the chat sweep. Uploads get a 24h grace window, so daily is enough.
            name: "Orphaned upload cleanup",
            cronExpression: "0 0 4 * * *",
            priority: 40,
            timeoutSeconds: 1800,
        },
    });
}
