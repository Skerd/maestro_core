/**
 * Core platform cron handlers.
 *
 * Auto-discovered by {@link module:loadAllCronHandlers}, which scans
 * `{module}/utilities/cron/` for `register*CronHandlers` exports.
 */

import {registerCronHandler} from "@coreModule/cronjobs/registry/handlerRegistry";
import {runPublicChatRetention} from "@coreModule/utilities/cronJobs/publicChatRetentionJob";

const GLOBAL_CRON = {
    type: "cron" as const,
    timezone: "UTC",
    singleton: true,
    executionStrategy: "distributed" as const,
    scope: "global" as const,
};

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
            ...GLOBAL_CRON,
            cronExpression: "0 30 3 * * *",
            priority: 40,
        },
    });
}
