import type {AnyBulkWriteOperation} from "mongodb";
import type {Model, PipelineStage} from "mongoose";
import ServerHealth1m, {IServerHealth1m} from "@coreModule/database/schemas/performance/serverHealth/serverHealth1m";
import ServerHealth1h from "@coreModule/database/schemas/performance/serverHealth/serverHealth1h";
import ServerHealth1d from "@coreModule/database/schemas/performance/serverHealth/serverHealth1d";

/** The service-health time series: 1-minute snapshots, rolled up into hours and days. */
const SERIES: Record<"1m" | "1h" | "1d", Model<unknown>> = {"1m": ServerHealth1m, "1h": ServerHealth1h, "1d": ServerHealth1d};
type Resolution = keyof typeof SERIES;

export const serverHealthService = {
    /** Appends one snapshot row per service (unordered: one bad row never drops the rest). */
    async insertSnapshots(docs: IServerHealth1m[]): Promise<void> {
        await ServerHealth1m.insertMany(docs, {ordered: false});
    },

    async aggregate<R>(resolution: Resolution, pipeline: PipelineStage[]): Promise<R[]> {
        return SERIES[resolution].aggregate<R>(pipeline).exec();
    },

    /** Writes rolled-up rows (unordered). */
    async insertRollups(resolution: Exclude<Resolution, "1m">, inserts: AnyBulkWriteOperation<unknown>[]): Promise<void> {
        await SERIES[resolution].bulkWrite(inserts, {ordered: false});
    },

    /** The rows of one resolution in `[from, to)`, oldest first. */
    async findWindow(resolution: Resolution, from: Date, to: Date): Promise<unknown[]> {
        return SERIES[resolution].find({bucketStart: {$gte: from, $lt: to}}).sort({bucketStart: 1}).lean();
    },
};
