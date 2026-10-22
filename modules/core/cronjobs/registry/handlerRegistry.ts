import type {CronHandlerRegistration} from "@coreModule/cronjobs/registry/types";

const handlers = new Map<string, CronHandlerRegistration>();

/** Idempotent: handler loading can run more than once in a process (seeding loads lazily). */
export function registerCronHandler(registration: CronHandlerRegistration): void {
    if (handlers.has(registration.code)) {
        return;
    }
    handlers.set(registration.code, registration);
}

export function getCronHandler(code: string): CronHandlerRegistration | undefined {
    return handlers.get(code);
}

export function listCronHandlerRegistrations(): CronHandlerRegistration[] {
    return [...handlers.values()];
}
