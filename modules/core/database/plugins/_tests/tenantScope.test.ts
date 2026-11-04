import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it} from "vitest";
import {MongoMemoryServer} from "mongodb-memory-server";
import mongoose, {Schema} from "mongoose";
import {ObjectId} from "mongodb";
import {ownershipPlugin} from "../ownershipPlugin";
import {requestContext} from "@coreModule/utilities/endpoints/requestContext";
import {asCrossTenant, setRequestTenant, withTenant} from "@coreModule/utilities/endpoints/tenantScope";

/* D16: queries on tenant models stay inside the current company; refusals fail closed. */

interface IBooking {
    title: string;
    company: ObjectId;
}

const bookingSchema = new Schema<IBooking>({title: String});
ownershipPlugin(bookingSchema);
const Booking = mongoose.model<IBooking>("TenantScopeBooking", bookingSchema);

const parentSchema = new Schema<IBooking>({title: String});
ownershipPlugin(parentSchema, {tenantScoped: false});
const Parent = mongoose.model<IBooking>("TenantScopeParent", parentSchema);

const companyA = new ObjectId();
const companyB = new ObjectId();
let mongo: MongoMemoryServer;

/** Runs `fn` like a request of the `pilot` module working on `company`. */
const asRequest = <T>(company: ObjectId | undefined, fn: () => PromiseLike<T>) =>
    requestContext.run({routeModule: "pilot", ...(company ? {tenantCompanyId: company.toString()} : {})}, async () => await fn());

const titles = (rows: {title: string}[]) => rows.map((row) => row.title).sort();

beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
});

beforeEach(async () => {
    await asCrossTenant("test fixtures", async () => {
        await Booking.deleteMany({});
        await Booking.create([
            {title: "a1", company: companyA},
            {title: "a2", company: companyA},
            {title: "b1", company: companyB},
        ]);
    });
});

afterEach(() => {
    delete process.env.TENANT_SCOPE_ENFORCE;
});

describe("enforced", () => {
    beforeEach(() => {
        process.env.TENANT_SCOPE_ENFORCE = "pilot";
    });

    it("limits a query without a company filter to the tenant", async () => {
        expect(titles(await asRequest(companyA, () => Booking.find({})))).toEqual(["a1", "a2"]);
        expect(await asRequest(companyA, () => Booking.countDocuments({}))).toBe(2);
    });

    it("does not reach another company's record by id", async () => {
        const b1 = await asCrossTenant("fixture lookup", () => Booking.findOne({title: "b1"}));
        expect(await asRequest(companyA, () => Booking.findById(b1!._id))).toBeNull();
        await asRequest(companyA, () => Booking.updateOne({_id: b1!._id}, {title: "changed"}));
        expect((await asCrossTenant("check", () => Booking.findById(b1!._id)))!.title).toBe("b1");
    });

    it("accepts an explicit filter on the tenant", async () => {
        expect(await asRequest(companyA, () => Booking.countDocuments({company: companyA}))).toBe(2);
        expect(await asRequest(companyA, () => Booking.countDocuments({company: {$in: [companyA.toString()]}}))).toBe(2);
    });

    it("refuses an explicit filter on another company", async () => {
        await expect(asRequest(companyA, () => Booking.find({company: companyB}))).rejects.toMatchObject({error_code: "tenant_scope_violation", status: 403});
        await expect(asRequest(companyA, () => Booking.find({company: {$in: [companyA, companyB]}}))).rejects.toMatchObject({error_code: "tenant_scope_violation"});
    });

    it("refuses a query when no company is known", async () => {
        await expect(asRequest(undefined, () => Booking.find({}))).rejects.toMatchObject({error_code: "tenant_context_missing", status: 500});
    });

    it("refuses moving a record to another company", async () => {
        await expect(asRequest(companyA, () => Booking.updateOne({title: "a1"}, {$set: {company: companyB}}))).rejects.toMatchObject({error_code: "tenant_scope_violation"});
        await expect(asRequest(companyA, () => Booking.create({title: "x", company: companyB}))).rejects.toMatchObject({error_code: "tenant_scope_violation"});
        await expect(asRequest(companyA, () => Booking.insertMany([{title: "y", company: companyB}]))).rejects.toMatchObject({error_code: "tenant_scope_violation"});
        await asRequest(companyA, () => Booking.create({title: "a3", company: companyA}));
        expect(await asRequest(companyA, () => Booking.countDocuments({}))).toBe(3);
    });

    it("scopes aggregations and refuses a pipeline matching another company", async () => {
        const rows = await asRequest(companyA, () => Booking.aggregate<{title: string}>([{$sort: {title: 1}}]));
        expect(titles(rows)).toEqual(["a1", "a2"]);
        await expect(asRequest(companyA, () => Booking.aggregate([{$match: {company: companyB}}]))).rejects.toMatchObject({error_code: "tenant_scope_violation"});
    });

    it("lets a marked block reach every company", async () => {
        const rows = await asRequest(companyA, () => asCrossTenant("platform overview", () => Booking.find({company: {$in: [companyA, companyB]}})));
        expect(titles(rows)).toEqual(["a1", "a2", "b1"]);
    });

    it("withTenant runs one company's slice inside a cross-company read", async () => {
        const rows = await asRequest(companyA, () => withTenant(companyB, () => Booking.find({}), "pilot"));
        expect(titles(rows)).toEqual(["b1"]);
    });

    it("setRequestTenant names the tenant for the rest of the request", async () => {
        const rows = await asRequest(undefined, async () => {
            setRequestTenant(companyB);
            return Booking.find({});
        });
        expect(titles(rows)).toEqual(["b1"]);
    });

    it("leaves models whose company is not a tenant alone", async () => {
        await asCrossTenant("fixture", () => Parent.create({title: "child of b", company: companyB}));
        expect(await asRequest(companyA, () => Parent.countDocuments({company: companyB}))).toBe(1);
    });

    it("does not enforce other modules", async () => {
        process.env.TENANT_SCOPE_ENFORCE = "someOtherModule";
        expect(titles(await asRequest(companyA, () => Booking.find({company: companyB})))).toEqual(["b1"]);
    });
});

describe("log-only (rollout default)", () => {
    it("changes nothing: queries return what they did before", async () => {
        expect(titles(await asRequest(companyA, () => Booking.find({})))).toEqual(["a1", "a2", "b1"]);
        expect(titles(await asRequest(companyA, () => Booking.find({company: companyB})))).toEqual(["b1"]);
        expect(await asRequest(undefined, () => Booking.countDocuments({}))).toBe(3);
    });
});
