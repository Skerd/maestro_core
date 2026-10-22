import type {serverLogger} from "@coreModule/loggers/serverLog";
import type {ICronExecution} from "@coreModule/database/schemas/cronExecution/cronExecution";
import type {ICronJob} from "@coreModule/database/schemas/cronJob/cronJob";
import {Types} from "mongoose";

export type CronHandlerContext = {
    job: ICronJob;
    execution: ICronExecution;
    /** The company that owns the job row. Jobs are seeded per company, so handlers scope their work to it. */
    company: Types.ObjectId;
    logger: serverLogger;
    signal: AbortSignal;
    appendLog: (line: string) => void;
};

export type CronHandlerFn = (ctx: CronHandlerContext) => Promise<void>;

/** Settings for the job row seeded per company; omitted fields take the CronJob schema defaults. */
export type CronJobDefaults = {
    name: string;
    cronExpression: string;
    active?: boolean;
    maxRetries?: number;
    retryDelaySeconds?: number;
    timeoutSeconds?: number;
    priority?: number;
};

export type CronHandlerRegistration = {
    code: string;
    handler: CronHandlerFn;
    defaultJob: CronJobDefaults;
};
