import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import {MongoMemoryServer} from "mongodb-memory-server";
import mongoose, {Schema} from "mongoose";
import {ObjectId} from "mongodb";

vi.hoisted(() => {
    process.env.ENABLED_MODULES = "core,carRental";
});

// Redis down: locks go through the CronLock collection and the heartbeat is skipped.
vi.mock("@coreModule/connections/connectToRedis", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@coreModule/connections/connectToRedis")>()),
    isRedisConnected: () => false,
}));

import CronJobModel from "@coreModule/database/schemas/cronJob/cronJob";
import CronExecution from "@coreModule/database/schemas/cronExecution/cronExecution";
import CronLock from "@coreModule/database/schemas/cronLock/cronLock";
import {registerCronHandler, setCronHandlerModule} from "../registry/handlerRegistry";
import {requestContext} from "@coreModule/utilities/endpoints/requestContext";
import {seedCronJobsForCompany, skipMissedCronRuns} from "../bootstrap/seedCompanyJobs";
import {SchedulerEngine} from "../engine/schedulerEngine";
import {asCrossTenant} from "@coreModule/utilities/endpoints/tenantScope";

// Stand-in for the model companyIdsWithModule resolves by name; only `modules` is read.
const Company = mongoose.model("Company", new Schema({modules: {type: [String], default: undefined}}));

/** The tests seed and read several companies' jobs; the code under test sets each run's own company (D16). */
const acrossCompanies = <T>(fn: () => PromiseLike<T>): Promise<T> => asCrossTenant("test fixtures span companies", fn);

const ran: string[] = [];
/** Each run's tenant context (D16): `code@company tenant module`. */
const contexts: string[] = [];
let mongo: MongoMemoryServer;

beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    await Promise.all([CronJobModel, CronExecution, CronLock].map((model) => model.init()));

    for (const code of ["test.core", "test.rental"]) {
        registerCronHandler({
            code,
            handler: async (ctx) => {
                ran.push(`${code}@${ctx.company}`);
                const store = requestContext.getStore();
                contexts.push(`${code}@${ctx.company} ${store?.tenantCompanyId} ${store?.routeModule}`);
            },
            defaultJob: {name: code, cronExpression: "0 0 * * * *"},
        });
    }
    setCronHandlerModule("test.rental", "carRental");
}, 120000);

afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
});

beforeEach(async () => {
    await Promise.all([CronJobModel, CronExecution, CronLock, Company].map((model) => model.collection.deleteMany({})));
    ran.length = 0;
    contexts.length = 0;
});

async function tick(): Promise<void> {
    const engine = new SchedulerEngine();
    await engine.start();
    await engine.stop();
}

describe("per-company module jobs", {timeout: 30000}, () => {
    it("seeds a module's jobs only for companies that have the module", () => acrossCompanies(async () => {
        const clinic = new ObjectId();
        await seedCronJobsForCompany(clinic, ["core"]);
        expect((await CronJobModel.find({company: clinic}).lean()).map((job) => job.code)).toEqual(["test.core"]);

        await seedCronJobsForCompany(clinic, ["core", "carRental"]);
        expect((await CronJobModel.find({company: clinic}).lean()).map((job) => job.code).sort()).toEqual(["test.core", "test.rental"]);
    }));

    it("runs a module's jobs only for companies that have the module", () => acrossCompanies(async () => {
        const rental = await Company.create({modules: ["core", "finance", "carRental"]});
        const clinic = await Company.create({modules: ["core", "finance", "dentalClinic"]});
        const due = new Date(Date.now() - 1_000);
        for (const company of [rental, clinic]) {
            for (const code of ["test.core", "test.rental"]) {
                await CronJobModel.create({company: company._id, code, handler: code, name: code, cronExpression: "0 0 * * * *", nextRunAt: due});
            }
        }

        await tick();

        expect(ran.sort()).toEqual([
            `test.core@${clinic._id}`,
            `test.core@${rental._id}`,
            `test.rental@${rental._id}`,
        ].sort());
        // Each run works on its own job's company, tagged with the handler's module.
        expect(contexts).toContain(`test.rental@${rental._id} ${rental._id} carRental`);
        expect(contexts).toContain(`test.core@${clinic._id} ${clinic._id} undefined`);
        // The clinic's rental job is left due, untouched, for when the module comes back.
        const parked = await CronJobModel.findOne({company: clinic._id, code: "test.rental"}).lean();
        expect(parked!.nextRunAt!.getTime()).toBe(due.getTime());
    }));

    it("moves overdue jobs of a re-enabled module to their next run", () => acrossCompanies(async () => {
        const company = new ObjectId();
        const longAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000);
        await CronJobModel.create({company, code: "test.rental", handler: "test.rental", name: "r", cronExpression: "0 0 * * * *", nextRunAt: longAgo});
        await CronJobModel.create({company, code: "test.core", handler: "test.core", name: "c", cronExpression: "0 0 * * * *", nextRunAt: longAgo});

        await skipMissedCronRuns(company, ["carRental"]);

        const rentalJob = await CronJobModel.findOne({company, code: "test.rental"}).lean();
        const coreJob = await CronJobModel.findOne({company, code: "test.core"}).lean();
        expect(rentalJob!.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
        expect(coreJob!.nextRunAt!.getTime()).toBe(longAgo.getTime());
    }));
});
