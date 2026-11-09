import {afterAll, beforeAll, beforeEach, describe, expect, it} from "vitest";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";
import mongoose, {Schema, type Document} from "mongoose";
import {ObjectId} from "mongodb";
import {ownershipPlugin} from "../ownershipPlugin";
import {auditPlugin} from "../auditPlugin";
import AuditLog from "@coreModule/database/schemas/auditLog/auditLog";
import {requestContext} from "@coreModule/utilities/endpoints/requestContext";
import {asCrossTenant, setRequestTenant, withTenant} from "@coreModule/utilities/endpoints/tenantScope";
import {BaseCrudService} from "@coreModule/database/services/baseCrudService";

/* D16: queries on tenant models stay inside the current company; refusals fail closed. */

interface IBooking extends Document {
    title: string;
    company: ObjectId;
}

const bookingSchema = new Schema<IBooking>({title: String});
ownershipPlugin(bookingSchema);
const Booking = mongoose.model<IBooking>("TenantScopeBooking", bookingSchema);

const parentSchema = new Schema<IBooking>({title: String});
ownershipPlugin(parentSchema, {tenantScoped: false});
auditPlugin(parentSchema);
const Parent = mongoose.model<IBooking>("TenantScopeParent", parentSchema);

interface IFile {
    title: string;
    company: ObjectId;
    sharedWith: ObjectId[];
}
const fileSchema = new Schema<IFile>({title: String, sharedWith: [Schema.Types.ObjectId]});
ownershipPlugin(fileSchema, {sharedWith: "sharedWith"});
const SharedFile = mongoose.model<IFile>("TenantScopeSharedFile", fileSchema);

const companyA = new ObjectId();
const companyB = new ObjectId();

/** Runs `fn` like a request of the `pilot` module working on `company`. */
const asRequest = <T>(company: ObjectId | undefined, fn: () => PromiseLike<T>) =>
    requestContext.run({routeModule: "pilot", ...(company ? {tenantCompanyId: company.toString()} : {})}, async () => await fn());

const titles = (rows: {title: string}[]) => rows.map((row) => row.title).sort();

beforeAll(async () => {
    await connectTestDatabase();
});

afterAll(async () => {
    await disconnectTestDatabase();
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

describe("tenant scoping", () => {
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

    it("audits a shared record under the record's own company", async () => {
        const child = await asRequest(companyA, () => Parent.create({title: "child company", company: companyB}));
        const entries = await asCrossTenant("check", () => AuditLog.countDocuments({documentId: child._id, company: companyB}));
        expect(entries).toBe(1);
    });

    it("reads a shared model's records the tenant owns or was shared, keeping the query's own $or", async () => {
        const companyC = new ObjectId();
        await asCrossTenant("fixture", async () => {
            await SharedFile.deleteMany({});
            await SharedFile.create([
                {title: "own", company: companyA, sharedWith: []},
                {title: "shared", company: companyB, sharedWith: [companyA]},
                {title: "foreign", company: companyB, sharedWith: [companyC]},
            ]);
        });
        expect(titles(await asRequest(companyA, () => SharedFile.find({})))).toEqual(["own", "shared"]);
        expect(titles(await asRequest(companyA, () => SharedFile.find({$or: [{title: "shared"}, {title: "foreign"}]})))).toEqual(["shared"]);
        // The sharee can take itself off the list; it cannot create files owned by someone else.
        await asRequest(companyA, () => SharedFile.updateOne({title: "shared"}, {$pull: {sharedWith: companyA}}));
        expect(titles(await asRequest(companyA, () => SharedFile.find({})))).toEqual(["own"]);
        await expect(asRequest(companyA, () => SharedFile.create({title: "x", company: companyB, sharedWith: [companyA]}))).rejects.toMatchObject({error_code: "tenant_scope_violation"});
    });

    it("narrows a filter on no company or an empty company list to the tenant instead of refusing it (it matches nothing either way)", async () => {
        expect(await asRequest(companyA, () => Booking.countDocuments({company: null}))).toBe(0);
        expect(await asRequest(companyA, () => Booking.countDocuments({company: {$in: []}}))).toBe(0);
    });

    it("treats a populated company as its id", async () => {
        // Mongoose casts a document-like value to its _id; scoping must read it the same way.
        expect(await asRequest(companyA, () => Booking.countDocuments({company: {_id: companyA, name: "A"}}))).toBe(2);
    });
});

describe("bulkWrite (TD-B114)", () => {
    const scoped = {error_code: "tenant_scope_violation", status: 403};

    it("narrows a tenant's batch to the tenant, including baseCrudService.bulkUpdate's _id filters", async () => {
        const b1 = await asCrossTenant("fixture lookup", () => Booking.findOne({title: "b1"}));
        await asRequest(companyA, () => Booking.bulkWrite([
            {updateOne: {filter: {_id: b1!._id}, update: {$set: {title: "changed"}}}},
            {replaceOne: {filter: {_id: b1!._id}, replacement: {title: "replaced", company: companyA}}},
            {updateMany: {filter: {$or: [{title: "a1"}, {title: "b1"}]}, update: {$set: {title: "renamed"}}}},
        ]));
        const service = new BaseCrudService<IBooking, typeof Booking>(Booking, "TenantScopeBooking");
        expect(await asRequest(companyA, () => service.bulkUpdate([{id: b1!._id, update: {$set: {title: "changed"}}}]))).toMatchObject({matchedCount: 0});
        await asRequest(companyA, () => Booking.bulkWrite([{deleteMany: {filter: {title: {$in: ["a2", "b1"]}}}}]));
        expect(titles(await asCrossTenant("check", () => Booking.find({})))).toEqual(["b1", "renamed"]);
    });

    it("refuses a filter on, or a write of, another company", async () => {
        await expect(asRequest(companyA, () => Booking.bulkWrite([{deleteMany: {filter: {company: companyB}}}]))).rejects.toMatchObject(scoped);
        await expect(asRequest(companyA, () => Booking.bulkWrite([{updateOne: {filter: {title: "a1"}, update: {$set: {company: companyB}}}}]))).rejects.toMatchObject(scoped);
        await expect(asRequest(companyA, () => Booking.bulkWrite([{replaceOne: {filter: {title: "a1"}, replacement: {title: "a1", company: companyB}}}]))).rejects.toMatchObject(scoped);
        expect(await asCrossTenant("check", () => Booking.countDocuments({company: companyB}))).toBe(1);
    });

    it("gives an inserted document the tenant's company and refuses another company's", async () => {
        await expect(asRequest(companyA, () => Booking.bulkWrite([{insertOne: {document: {title: "x", company: companyB}}}]))).rejects.toMatchObject(scoped);
        await asRequest(companyA, () => Booking.bulkWrite([
            {insertOne: {document: {title: "a3"}}},
            {insertOne: {document: {title: "a4", company: companyA}}},
        ]));
        expect(titles(await asCrossTenant("check", () => Booking.find({company: companyA})))).toEqual(["a1", "a2", "a3", "a4"]);
    });

    it("lets a marked block reach every company and leaves non-tenant models alone", async () => {
        await asRequest(companyA, () => asCrossTenant("platform sweep", () => Booking.bulkWrite([{updateMany: {filter: {}, update: {$set: {title: "swept"}}}}])));
        expect(await asCrossTenant("check", () => Booking.countDocuments({title: "swept"}))).toBe(3);
        await asRequest(companyA, () => Parent.bulkWrite([{insertOne: {document: {title: "child of b", company: companyB}}}]));
        expect(await asRequest(companyA, () => Parent.countDocuments({company: companyB}))).toBeGreaterThan(0);
    });

    it("refuses a batch when no company is known", async () => {
        await expect(asRequest(undefined, () => Booking.bulkWrite([{updateMany: {filter: {}, update: {$set: {title: "x"}}}}]))).rejects.toMatchObject({error_code: "tenant_context_missing", status: 500});
        await expect(asRequest(undefined, () => Booking.bulkWrite([{insertOne: {document: {title: "x", company: companyA}}}]))).rejects.toMatchObject({error_code: "tenant_context_missing"});
        expect(await asCrossTenant("check", () => Booking.countDocuments({title: "x"}))).toBe(0);
    });
});
