import type {serverLogger} from "@coreModule/loggers/serverLog";
import type {ICronExecution} from "@coreModule/database/schemas/cronExecution/cronExecution";
import type {ICronJob} from "@coreModule/database/schemas/cronJob/cronJob";
import {Types} from "mongoose";

export type CronHandlerContext = {
    job: ICronJob;
    execution: ICronExecution;
    company: Types.ObjectId | null;
    logger: serverLogger;
    signal: AbortSignal;
    metadata: Record<string, unknown>;
    appendLog: (line: string) => void;
};

export type CronHandlerFn = (ctx: CronHandlerContext) => Promise<void>;

export type CronHandlerRegistration = {
    code: string;
    handler: CronHandlerFn;
    version?: string;
    defaultJob?: Partial<CronJobSeed>;
};

export type CronJobSeed = {
    code: string;
    name: string;
    handler: string;
    type: ICronJob["type"];
    cronExpression?: string;
    interval?: ICronJob["interval"];
    timezone?: string;
    active?: boolean;
    singleton?: boolean;
    executionStrategy?: ICronJob["executionStrategy"];
    maxRetries?: number;
    retryDelaySeconds?: number;
    timeoutSeconds?: number;
    priority?: number;
    scope?: ICronJob["scope"];
    missedRunPolicy?: ICronJob["missedRunPolicy"];
};
