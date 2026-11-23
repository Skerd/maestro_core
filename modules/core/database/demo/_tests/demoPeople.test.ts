/**
 * TD-B240: demo people read wrong in the panel. The shop company had no sign-up users (Company → Users was empty), and
 * each company's AI bot had a made-up birthday and phone and Berlin's zone in Tirana.
 */
import {afterAll, beforeAll, beforeEach, describe, expect, it} from "vitest";
import mongoose from "mongoose";
import {ObjectId} from "mongodb";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";
import {getLogger} from "@coreModule/loggers/serverLog";
import {withTenant} from "@coreModule/utilities/endpoints/tenantScope";
import Company from "@coreModule/database/schemas/company/company";
import {CORE_DEMO_CHANNEL_NAME} from "@coreModule/database/schemas/channel/channel.defaults";
import {CORE_DEMO_CUSTOMER_PASSWORD, coreDemoCustomerSeeds, createDemoSignupUsers} from "@coreModule/database/demo/demoSignupUsers";

const companyId = new ObjectId();
const signupRole = new ObjectId();
const staffRole = new ObjectId();
const logger = getLogger("core_demo_people_test");
const db = () => mongoose.connection.db!;
const asCompany = <T>(fn: () => Promise<T>) => withTenant(companyId, fn);

beforeAll(async () => {
    await connectTestDatabase();
}, 120000);

afterAll(async () => {
    await disconnectTestDatabase();
});

beforeEach(async () => {
    for (const name of ["companies", "roles", "users"]) await db().collection(name).deleteMany({});
    await db().collection("companies").insertOne({_id: companyId, company: companyId, name: "Kudoo Market", vat: "KM", timezone: "Europe/Tirane", deletedAt: null});
    await db().collection("roles").insertMany([
        {_id: signupRole, company: companyId, name: "Customer", slug: "customer", isSignupDefault: true, permissions: []},
        {_id: staffRole, company: companyId, name: "Staff", slug: "staff", isSignupDefault: false, permissions: []},
    ]);
});

describe("demo customers", () => {
    it("joins every demo company with its sign-up role in the company's zone, once", () => asCompany(async () => {
        const company = (await Company.findById(companyId))!;
        await createDemoSignupUsers(logger, company, coreDemoCustomerSeeds, CORE_DEMO_CUSTOMER_PASSWORD);
        await createDemoSignupUsers(logger, company, coreDemoCustomerSeeds, CORE_DEMO_CUSTOMER_PASSWORD);

        const customers = await db().collection("users").find({"roles.roles": signupRole}).toArray();
        expect(customers.map((user) => user.username).sort()).toEqual(coreDemoCustomerSeeds.map((seed) => seed.username).sort());
        expect(customers.every((user) => user.timezone === "Europe/Tirane" && user.roles.length === 1)).toBe(true);
    }));
});

describe("a sample company (D178, TD-B257)", () => {
    it("gets no demo customers: in production they would sign in to it with the shared password", async () => {
        const sampleId = new ObjectId();
        const sample = {_id: sampleId, name: "Kudoo Market (sample)", createdBy: undefined, timezone: "Europe/Tirane"};
        await db().collection("companies").insertOne({...sample, company: companyId, parentCompany: companyId, isSandbox: true, vat: "KMS", deletedAt: null});
        await db().collection("roles").insertOne({_id: new ObjectId(), company: sampleId, name: "Customer", slug: "customer-sample", isSignupDefault: true, permissions: []});

        await withTenant(sampleId, () => createDemoSignupUsers(logger, sample, coreDemoCustomerSeeds, CORE_DEMO_CUSTOMER_PASSWORD));

        expect(await db().collection("users").countDocuments({})).toBe(0);
    });
});

describe("company bot", () => {
    it("takes the company's zone and carries no birthday or phone", () => asCompany(async () => {
        await (await Company.findById(companyId))!.createBot();

        const bot = (await db().collection("users").findOne({isBot: true, companies: companyId}))!;
        expect(bot.timezone).toBe("Europe/Tirane");
        expect(bot.birthday).toBeUndefined();
        expect(bot.phoneNumber).toBeUndefined();
    }));
});

describe("demo group chat", () => {
    it("has a name a person can read", () => {
        expect(CORE_DEMO_CHANNEL_NAME).not.toMatch(/demo-seed|:/);
    });
});
