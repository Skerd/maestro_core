import type {AnyBulkWriteOperation} from "mongodb";
import type {Model, PipelineStage} from "mongoose";
import ServerPerformance1m from "@coreModule/database/schemas/performance/serverPerformance/serverPerformance1m";
import ServerPerformance1h from "@coreModule/database/schemas/performance/serverPerformance/serverPerformance1h";
import ServerPerformance1d from "@coreModule/database/schemas/performance/serverPerformance/serverPerformance1d";

/** The endpoint-performance time series: 1-minute buckets, rolled up into hours and days. */
const SERIES: Record<"1m" | "1h" | "1d", Model<unknown>> = {"1m": ServerPerformance1m, "1h": ServerPerformance1h, "1d": ServerPerformance1d};
type Resolution = keyof typeof SERIES;

export const serverPerformanceService = {
    async aggregate<R>(resolution: Resolution, pipeline: PipelineStage[]): Promise<R[]> {
        return SERIES[resolution].aggregate<R>(pipeline).exec();
    },

    /** Writes buckets (unordered: one bad row never drops the rest). */
    async insertBuckets(resolution: Resolution, inserts: AnyBulkWriteOperation<unknown>[]): Promise<void> {
        await SERIES[resolution].bulkWrite(inserts, {ordered: false});
    },
};
