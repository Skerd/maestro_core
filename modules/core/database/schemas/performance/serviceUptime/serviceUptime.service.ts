import type {ObjectId} from "mongodb";
import {BaseCrudService} from "@coreModule/database/services/baseCrudService";
import ServiceUptime, {IServiceUptime} from "@coreModule/database/schemas/performance/serviceUptime/serviceUptime";

/** The service uptime ledger: one row per start of a service in a process (`utilities/uptime/uptimeKeeper.ts`). */
class ServiceUptimeService extends BaseCrudService<IServiceUptime, typeof ServiceUptime> {
    constructor() {
        super(ServiceUptime, "ServiceUptime");
    }

    /** Opens a row for a service that just started. */
    async recordStart(row: Partial<IServiceUptime>): Promise<IServiceUptime> {
        return this.model.create(row);
    }

    /** The latest row per service on `host` that has not stopped (`stoppedAt` is only ever set, never null). */
    async latestOpenRowsOnHost(host: string): Promise<IServiceUptime[]> {
        return this.model.aggregate<IServiceUptime>([
            {$match: {host, stoppedAt: {$exists: false}}},
            {$sort: {startedAt: -1}},
            {$group: {_id: "$service", doc: {$first: "$$ROOT"}}},
            {$replaceRoot: {newRoot: "$doc"}},
        ]).exec();
    }

    async touch(rowId: ObjectId, field: "lastSeenAt" | "stoppedAt"): Promise<void> {
        await this.model.updateOne({_id: rowId}, {$set: {[field]: new Date()}});
    }
}

export const serviceUptimeService = new ServiceUptimeService();
