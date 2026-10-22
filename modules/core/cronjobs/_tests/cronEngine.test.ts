import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import {MongoMemoryServer} from "mongodb-memory-server";
import mongoose from "mongoose";
import {ObjectId} from "mongodb";

// Redis down: locks go through the CronLock collection and the heartbeat is skipped.
vi.mock("@coreModule/connections/connectToRedis", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@coreModule/connections/connectToRedis")>()),
    isRedisConnected: () => false,
}));

import CronJobModel, {type ICronJob} from "@coreModule/database/schemas/cronJob/cronJob";
import CronExecution from "@coreModule/database/schemas/cronExecution/cronExecution";
import CronLock from "@coreModule/database/schemas/cronLock/cronLock";
import {registerCronHandler} from "../registry/handlerRegistry";
import type {CronHandlerContext} from "../registry/types";
import {jobRunner} from "../engine/jobRunner";
import {SchedulerEngine} from "../engine/schedulerEngine";

const HOUR = 3600 * 1000;
const company = new ObjectId();
const seen: CronHandlerContext[] = [];
let failNext = false;

let mongo: MongoMemoryServer;

beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    await Promise.all([CronJobModel, CronExecution, CronLock].map((model) => model.init()));

    registerCronHandler({
        code: "test.record",
        handler: async (ctx) => {
            seen.push(ctx);
            if (failNext) throw new Error("boom");
        },
        defaultJob: {name: "Record", cronExpression: "0 0 * * * *"},
    });
    registerCronHandler({
        code: "test.hang",
        handler: () => new Promise(() => undefined),
        defaultJob: {name: "Hang", cronExpression: "0 0 * * * *"},
    });
}, 120000);

afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
});

beforeEach(async () => {
    await Promise.all([CronJobModel, CronExecution, CronLock].map((model) => model.collection.deleteMany({})));
    seen.length = 0;
    failNext = false;
});

async function createJob(fields: Partial<ICronJob> & {handler: string}): Promise<ICronJob> {
    const job = await CronJobModel.create({
        company,
        code: fields.handler,
        name: fields.handler,
        cronExpression: "0 0 * * * *",
        nextRunAt: new Date(Date.now() - 1_000),
        ...fields,
    });
    return job.toObject() as ICronJob;
}

/**
 * One scheduler tick, then wait for the runs it started. A fresh engine each
 * time, so its first tick also self-heals (later ticks heal every 5 minutes).
 */
async function tick(): Promise<void> {
    const engine = new SchedulerEngine();
    await engine.start();
    await engine.stop();
}

describe("job runner", {timeout: 30000}, () => {
    it("records a failure, pulls nextRunAt forward to the retry, and frees the job", async () => {
        const job = await createJob({handler: "test.record", maxRetries: 2, retryDelaySeconds: 60, nextRunAt: new Date(Date.now() + 2 * HOUR)});
        failNext = true;

        jobRunner.start(job, 1);
        expect(jobRunner.hasCapacity(job)).toBe(false);
        await jobRunner.awaitActiveRuns();

        const execution = (await CronExecution.findOne({jobId: job._id}).lean())!;
        expect(execution).toMatchObject({status: "failed", attempt: 1, error: {message: "boom"}});
        expect(String(execution.company)).toBe(String(company));
        expect(seen[0].company.toString()).toBe(company.toString());

        const stored = (await CronJobModel.findById(job._id).lean())!;
        expect(stored.nextRunAt!.getTime()).toBe(execution.nextRetryAt!.getTime());
        expect(stored.nextRunAt!.getTime()).toBeLessThan(Date.now() + 2 * 60_000 + 1_000);
        expect(stored.lastRunAt).toBeInstanceOf(Date);

        expect(jobRunner.hasCapacity(job)).toBe(true);
        expect(await CronLock.countDocuments()).toBe(0);
    });

    it("numbers the retry as the next attempt", async () => {
        const job = await createJob({handler: "test.record", maxRetries: 2, retryDelaySeconds: 0});
        failNext = true;
        jobRunner.start(job, 1);
        await jobRunner.awaitActiveRuns();
        failNext = false;
        jobRunner.start(job, 1);
        await jobRunner.awaitActiveRuns();

        const attempts = await CronExecution.find({jobId: job._id}).sort({startedAt: 1}).lean();
        expect(attempts.map((e) => [e.status, e.attempt])).toEqual([["failed", 1], ["success", 2]]);
    });

    it("times a hung handler out and aborts its signal", async () => {
        const job = await createJob({handler: "test.hang", timeoutSeconds: 1, maxRetries: 0});

        jobRunner.start(job, 1);
        await jobRunner.awaitActiveRuns();

        const execution = (await CronExecution.findOne({jobId: job._id}).lean())!;
        expect(execution.status).toBe("timeout");
        expect(execution.nextRetryAt).toBeUndefined();
        expect(await CronLock.countDocuments()).toBe(0);
    });

    it("skips a run while another instance holds the job lock", async () => {
        const job = await createJob({handler: "test.record"});
        await CronLock.create({key: `cron:lock:${job._id}`, owner: "other", token: "t", expiresAt: new Date(Date.now() + 60_000), heartbeatAt: new Date()});

        jobRunner.start(job, 1);
        await jobRunner.awaitActiveRuns();

        expect(seen).toHaveLength(0);
        expect(await CronExecution.countDocuments()).toBe(0);
    });
});

describe("scheduler", {timeout: 30000}, () => {
    it("runs a due job and moves nextRunAt to the next occurrence", async () => {
        const job = await createJob({handler: "test.record"});

        await tick();

        expect(seen).toHaveLength(1);
        const stored = (await CronJobModel.findById(job._id).lean())!;
        expect(stored.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
        expect(await CronExecution.countDocuments({jobId: job._id, status: "success"})).toBe(1);
    });

    it("leaves paused jobs and jobs without a registered handler alone", async () => {
        await createJob({handler: "test.record", active: false});
        await createJob({handler: "test.unregistered"});

        await tick();

        expect(seen).toHaveLength(0);
        expect(await CronExecution.countDocuments()).toBe(0);
    });

    it("applies the missed-run policy to a backlog", async () => {
        const threeHoursAgo = new Date(Date.now() - 3 * HOUR - 60_000);
        const skip = await createJob({handler: "test.record", code: "skip", missedRunPolicy: "skip", nextRunAt: threeHoursAgo});
        await tick();
        expect(seen).toHaveLength(0);
        expect((await CronJobModel.findById(skip._id).lean())!.nextRunAt!.getTime()).toBeGreaterThan(Date.now());

        await createJob({handler: "test.record", code: "catch_up", missedRunPolicy: "catch_up", nextRunAt: threeHoursAgo});
        await tick();
        expect(seen.length).toBeGreaterThanOrEqual(3);
    });

    it("runs a job whose nextRunAt was set to now (Run now)", async () => {
        const job = await createJob({handler: "test.record", nextRunAt: new Date(Date.now() + HOUR)});
        await CronJobModel.updateOne({_id: job._id}, {$set: {nextRunAt: new Date()}});

        await tick();

        expect(seen).toHaveLength(1);
    });

    it("closes executions left running past their timeout by a dead process", async () => {
        const job = await createJob({handler: "test.record", timeoutSeconds: 60, nextRunAt: new Date(Date.now() + HOUR)});
        const abandoned = await CronExecution.create({jobId: job._id, company, status: "running", startedAt: new Date(Date.now() - 10 * 60_000), attempt: 1});
        const live = await CronExecution.create({jobId: job._id, company, status: "running", startedAt: new Date(Date.now() - 2.5 * 60_000), attempt: 1});

        await tick();

        expect((await CronExecution.findById(abandoned._id).lean())!.status).toBe("timeout");
        expect((await CronExecution.findById(live._id).lean())!.status).toBe("running");
    });
});
