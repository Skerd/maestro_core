import {registerCronHandler} from "@coreModule/cronjobs/registry/handlerRegistry";

/** Placeholder for core-native handlers (metrics rollups, etc.). */
export function registerCoreCronHandlers(): void {
    registerCronHandler({
        code: "core.noopHealthCheck",
        handler: async ctx => {
            ctx.appendLog("noop health check ok");
        },
        version: "1",
    });
}
