/**
 * Core platform cron handlers.
 *
 * Auto-discovered by {@link module:loadAllCronHandlers}, which scans
 * `{module}/utilities/cron/` for `register*CronHandlers` exports.
 */

import {registerCronHandler} from "@coreModule/cronjobs/registry/handlerRegistry";
import {runPublicChatRetention} from "@coreModule/utilities/cronJobs/publicChatRetentionJob";
import {runOrphanUploadCleanup} from "@coreModule/utilities/cronJobs/orphanUploadCleanupJob";
import {runSiteHostProbe} from "@coreModule/utilities/cronJobs/siteHostProbeJob";
import {runSavedSearchAlerts} from "@coreModule/utilities/cronJobs/savedSearchAlertsJob";

export function registerCorePlatformCronHandlers(): void {
    registerCronHandler({
        code: "core.publicChatRetention",
        handler: async ctx => {
            await runPublicChatRetention(ctx.company, ctx.logger);
        },
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
            const result = await runOrphanUploadCleanup(ctx.company, ctx.logger, {signal: ctx.signal});
            ctx.appendLog(
                `examined ${result.examined}, in use ${result.claimed}, deleted ${result.deleted}, failed ${result.failed}`,
            );
        },
        defaultJob: {
            // Nightly, after the chat sweep. Uploads get a 24h grace window, so daily is enough.
            name: "Orphaned upload cleanup",
            cronExpression: "0 0 4 * * *",
            priority: 40,
            timeoutSeconds: 1800,
        },
    });

    registerCronHandler({
        code: "core.savedSearchAlerts",
        handler: async ctx => {
            // Saved searches live in the platform company (P23.7): every other company's run finds none.
            const result = await runSavedSearchAlerts(ctx.company, {logger: ctx.logger});
            ctx.appendLog(
                `checked ${result.searches} saved search(es) of ${result.people} person(s): sent ${result.sent}, failed ${result.failed}, ${result.items} new item(s)`,
            );
        },
        defaultJob: {
            // Once a day, in the morning: a digest of what was listed since the last one.
            name: "Saved-search alerts",
            cronExpression: "0 0 8 * * *",
            priority: 30,
            timeoutSeconds: 1800,
        },
    });

    registerCronHandler({
        code: "core.siteHostProbe",
        handler: async ctx => {
            await runSiteHostProbe(ctx);
        },
        defaultJob: {
            // Stops probing once the site answers as this company.
            name: "Site host probe",
            cronExpression: "0 */1 * * * *",
            priority: 15,
        },
    });
}
