import type {CronHandlerFn, CronHandlerRegistration} from "@coreModule/cronjobs/registry/types";

const handlers = new Map<string, CronHandlerRegistration>();

export function registerCronHandler(registration: CronHandlerRegistration): void {
    if (handlers.has(registration.code)) {
        return;
    }
    handlers.set(registration.code, registration);
}

export function getCronHandler(code: string): CronHandlerRegistration | undefined {
    return handlers.get(code);
}

export function hasCronHandler(code: string): boolean {
    return handlers.has(code);
}

export function listCronHandlers(): string[] {
    return [...handlers.keys()];
}

export function assertCronHandlerRegistered(handler: string): void {
    if (!handlers.has(handler)) {
        throw new Error(`Unknown cron handler: ${handler}. Registered: ${listCronHandlers().join(", ")}`);
    }
}

export function getCronHandlerFn(code: string): CronHandlerFn {
    const reg = getCronHandler(code);
    if (!reg) {
        throw new Error(`Unknown cron handler: ${code}`);
    }
    return reg.handler;
}

export function clearCronHandlersForTests(): void {
    handlers.clear();
}
