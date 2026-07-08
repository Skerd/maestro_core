import CronJobModel from "@coreModule/database/schemas/cronJob/cronJob";
import {computeNextRunAt} from "@coreModule/cronjobs/scheduling/nextRunCalculator";
import {listCronHandlers} from "@coreModule/cronjobs/registry/handlerRegistry";
import {getLogger} from "@coreModule/loggers/serverLog";

const logger = getLogger("cron_seed");

const PLATFORM_JOBS = [
    {
        code: "eCommerce.orderAutoComplete",
        name: "Order auto-complete",
        handler: "eCommerce.orderAutoComplete",
        type: "cron" as const,
        cronExpression: "0 0 * * * *",
        timezone: "UTC",
        singleton: true,
        executionStrategy: "distributed" as const,
        scope: "global" as const,
        priority: 20,
    },
    {
        code: "eCommerce.taskRequestExpiry",
        name: "Task request expiry",
        handler: "eCommerce.taskRequestExpiry",
        type: "cron" as const,
        cronExpression: "0 0 * * * *",
        timezone: "UTC",
        singleton: true,
        executionStrategy: "distributed" as const,
        scope: "global" as const,
        priority: 20,
    },
    {
        code: "propertyManagement.reservationExpirationReminder",
        name: "Reservation expiration reminder",
        handler: "propertyManagement.reservationExpirationReminder",
        type: "cron" as const,
        cronExpression: "0 10 8 * * *",
        timezone: "UTC",
        singleton: true,
        executionStrategy: "distributed" as const,
        scope: "global" as const,
        priority: 15,
    },
    {
        code: "propertyManagement.paymentPlanInstallmentReminder",
        name: "Payment plan installment reminder",
        handler: "propertyManagement.paymentPlanInstallmentReminder",
        type: "cron" as const,
        cronExpression: "0 12 8 * * *",
        timezone: "UTC",
        singleton: true,
        executionStrategy: "distributed" as const,
        scope: "global" as const,
        priority: 15,
    },
    {
        code: "propertyManagement.rentalMaintenance",
        name: "Rental payment overdue and lease expiry",
        handler: "propertyManagement.rentalMaintenance",
        type: "cron" as const,
        cronExpression: "0 15 8 * * *",
        timezone: "UTC",
        singleton: true,
        executionStrategy: "distributed" as const,
        scope: "global" as const,
        priority: 15,
    },
    {
        code: "eCommerce.lowStockAlert",
        name: "Low stock alert",
        handler: "eCommerce.lowStockAlert",
        type: "cron" as const,
        cronExpression: "0 0 * * * *",
        timezone: "UTC",
        singleton: true,
        executionStrategy: "distributed" as const,
        scope: "global" as const,
        priority: 10,
    },
    {
        code: "eCommerce.collectionRebuild",
        name: "Collection rebuild",
        handler: "eCommerce.collectionRebuild",
        type: "cron" as const,
        cronExpression: "0 30 * * * *",
        timezone: "UTC",
        singleton: true,
        executionStrategy: "distributed" as const,
        scope: "global" as const,
        priority: 5,
    },
    {
        code: "eCommerce.scheduledPublish",
        name: "Scheduled publish",
        handler: "eCommerce.scheduledPublish",
        type: "cron" as const,
        cronExpression: "0 */5 * * * *",
        timezone: "UTC",
        singleton: true,
        executionStrategy: "distributed" as const,
        scope: "global" as const,
        priority: 25,
    },
];

export async function seedPlatformCronJobs(): Promise<void> {
    const registered = new Set(listCronHandlers());
    for (const seed of PLATFORM_JOBS) {
        if (!registered.has(seed.handler)) {
            logger.warn(`Skipping seed ${seed.code}: handler not registered`);
            continue;
        }
        const existing = await CronJobModel.findOne({code: seed.code, company: null});
        const nextRunAt = computeNextRunAt(seed, new Date());
        if (existing) {
            await CronJobModel.updateOne(
                {_id: existing._id},
                {
                    $setOnInsert: {},
                    $set: {
                        name: seed.name,
                        handler: seed.handler,
                        type: seed.type,
                        cronExpression: seed.cronExpression,
                        timezone: seed.timezone,
                        active: true,
                        ...(!existing.nextRunAt && nextRunAt ? {nextRunAt} : {}),
                    },
                },
            );
            continue;
        }
        await CronJobModel.create({
            ...seed,
            company: null,
            active: true,
            maxRetries: 3,
            retryDelaySeconds: 60,
            timeoutSeconds: 600,
            allowParallelRuns: false,
            missedRunPolicy: "skip",
            nextRunAt,
        });
        logger.debug(`Seeded cron job ${seed.code}`);
    }
}
