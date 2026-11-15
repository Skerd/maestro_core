import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";
import mongoose, {Schema} from "mongoose";
import {ObjectId} from "mongodb";
import {ownershipPlugin} from "../ownershipPlugin";
import {lifeCyclePlugin} from "../lifeCyclePlugin";
import {requestContext} from "@coreModule/utilities/endpoints/requestContext";
import {allowForeignReferences, asCrossTenant} from "@coreModule/utilities/endpoints/tenantScope";
import {checkTenantReferences} from "../tenantReferences";
import Company from "@coreModule/database/schemas/company/company";
import User from "@coreModule/database/schemas/user/user";
import Role from "@coreModule/database/schemas/role/role";
import Country from "@coreModule/database/schemas/country/country";
import Media from "@coreModule/database/schemas/media/media";

/* D104: a tenant record's stored references to tenant-owned rows stay inside its company. */

interface IRate {
    code: string;
    company: ObjectId;
}
const rateSchema = new Schema<IRate>({code: String});
ownershipPlugin(rateSchema);
lifeCyclePlugin(rateSchema);
const Rate = mongoose.model<IRate>("TenantRefRate", rateSchema);

interface IFile {
    title: string;
    company: ObjectId;
    sharedWith: ObjectId[];
}
const fileSchema = new Schema<IFile>({title: String, sharedWith: [Schema.Types.ObjectId]});
ownershipPlugin(fileSchema, {sharedWith: "sharedWith"});
const SharedFile = mongoose.model<IFile>("TenantRefFile", fileSchema);

/** A model without tenant ownership, like User: references to it are not checked. */
const globalSchema = new Schema<{name: string}>({name: String});
lifeCyclePlugin(globalSchema);
const GlobalRow = mongoose.model("TenantRefGlobal", globalSchema);

interface IOrder {
    note?: string;
    company: ObjectId;
    rate?: unknown;
    rates?: unknown[];
    lines?: {rate?: unknown; quantity?: number}[];
    address?: {rate?: unknown};
    file?: unknown;
    owner?: unknown;
}
const orderSchema = new Schema<IOrder>({
    note: String,
    rate: {type: Schema.Types.ObjectId, ref: "TenantRefRate"},
    rates: [{type: Schema.Types.ObjectId, ref: "TenantRefRate"}],
    lines: [{rate: {type: Schema.Types.ObjectId, ref: "TenantRefRate"}, quantity: Number}],
    address: {rate: {type: Schema.Types.ObjectId, ref: "TenantRefRate"}},
    file: {type: Schema.Types.ObjectId, ref: "TenantRefFile"},
    owner: {type: Schema.Types.ObjectId, ref: "TenantRefGlobal"},
});
ownershipPlugin(orderSchema);
lifeCyclePlugin(orderSchema);
const Order = mongoose.model<IOrder>("TenantRefOrder", orderSchema);

/** A record whose references must be its own rows, like Company (judged by `_id`). */
const ownRecordSchema = new Schema<{name?: string; rate?: unknown; file?: unknown}>({
    name: String,
    rate: {type: Schema.Types.ObjectId, ref: "TenantRefRate"},
    file: {type: Schema.Types.ObjectId, ref: "TenantRefFile"},
});
checkTenantReferences(ownRecordSchema, "_id");
const OwnRecord = mongoose.model("TenantRefOwnRecord", ownRecordSchema);

/** A record with one entry per company, like User memberships (`roles[].company`). */
const memberSchema = new Schema<{memberships: {company: unknown; rates: unknown[]; note?: string}[]}>({
    memberships: [{company: Schema.Types.ObjectId, rates: [{type: Schema.Types.ObjectId, ref: "TenantRefRate"}], note: String}],
});
checkTenantReferences(memberSchema, "memberships.company");
const Member = mongoose.model("TenantRefMember", memberSchema);

const companyA = new ObjectId();
const companyB = new ObjectId();

/** Runs `fn` as a request of company A. */
const asA = <T>(fn: () => PromiseLike<T>) =>
    requestContext.run({routeModule: "pilot", tenantCompanyId: companyA.toString()}, async () => await fn());

const refused = {error_code: "reference_outside_tenant", status: 403};

let ownRate: ObjectId, otherOwnRate: ObjectId, foreignRate: ObjectId;

beforeAll(async () => {
    await connectTestDatabase();
});

afterAll(async () => {
    await disconnectTestDatabase();
});

beforeEach(async () => {
    await asCrossTenant("test fixtures", async () => {
        await Promise.all([Rate.deleteMany({}), Order.deleteMany({}), SharedFile.deleteMany({}), OwnRecord.deleteMany({}), Member.deleteMany({})]);
        const [own, otherOwn, foreign] = await Rate.create([
            {code: "EUR", company: companyA},
            {code: "CHF", company: companyA},
            {code: "EUR", company: companyB},
        ]);
        ownRate = own._id;
        otherOwnRate = otherOwn._id;
        foreignRate = foreign._id;
    });
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("reference ownership on create", () => {
    it("accepts the company's own row and refuses another company's", async () => {
        await expect(asA(() => Order.create({company: companyA, rate: ownRate}))).resolves.toBeTruthy();
        await expect(asA(() => Order.create({company: companyA, rate: foreignRate}))).rejects.toMatchObject(refused);
        expect(await asA(() => Order.countDocuments({}))).toBe(1);
    });

    it("names the field in the refusal", async () => {
        await expect(asA(() => Order.create({company: companyA, address: {rate: foreignRate}})))
            .rejects.toMatchObject({...refused, content: ["TenantRefOrder.address.rate"]});
    });

    it("refuses an array of refs or sub-documents with one foreign row", async () => {
        await expect(asA(() => Order.create({company: companyA, rates: [ownRate, foreignRate]}))).rejects.toMatchObject(refused);
        await expect(asA(() => Order.create({company: companyA, lines: [{rate: ownRate}, {rate: foreignRate}]}))).rejects.toMatchObject(refused);
        await expect(asA(() => Order.create({company: companyA, rates: [ownRate, otherOwnRate], lines: [{rate: ownRate}]}))).resolves.toBeTruthy();
    });

    it("reads populated and legacy {_id} shapes", async () => {
        const own = await asA(() => Rate.findById(ownRate));
        await expect(asA(() => Order.create({company: companyA, rate: own}))).resolves.toBeTruthy();
        await expect(asA(() => Order.create({company: companyA, rate: {_id: ownRate.toString(), code: "EUR"}}))).resolves.toBeTruthy();
        const foreign = await asCrossTenant("fixture", () => Rate.findById(foreignRate));
        await expect(asA(() => Order.create({company: companyA, rate: foreign}))).rejects.toMatchObject(refused);
        await expect(asA(() => Order.create({company: companyA, rate: {_id: foreignRate, code: "EUR"}}))).rejects.toMatchObject(refused);
    });

    it("leaves references to models without tenant ownership and ids that name no row alone", async () => {
        await expect(asA(() => Order.create({company: companyA, owner: new ObjectId(), rate: new ObjectId()}))).resolves.toBeTruthy();
    });

    it("accepts a shared row only when it is shared with the record's company", async () => {
        const [shared, private_] = await asCrossTenant("fixture", () => SharedFile.create([
            {title: "shared", company: companyB, sharedWith: [companyA]},
            {title: "private", company: companyB, sharedWith: []},
        ]));
        await expect(asA(() => Order.create({company: companyA, file: shared._id}))).resolves.toBeTruthy();
        await expect(asA(() => Order.create({company: companyA, file: private_._id}))).rejects.toMatchObject(refused);
    });

    it("refuses insertMany with a foreign row", async () => {
        await expect(asA(() => Order.insertMany([{company: companyA, rate: ownRate}, {company: companyA, rates: [foreignRate]}])))
            .rejects.toMatchObject(refused);
        expect(await asA(() => Order.countDocuments({}))).toBe(0);
    });
});

describe("reference ownership on update", () => {
    it("refuses a save that switches to a foreign row", async () => {
        const order = await asA(() => Order.create({company: companyA, rate: ownRate}));
        order.rate = foreignRate;
        await expect(asA(() => order.save())).rejects.toMatchObject(refused);
        expect((await asA(() => Order.findById(order._id)))!.rate).toEqual(ownRate);
    });

    it("refuses update queries that set, push or add a foreign row", async () => {
        const order = await asA(() => Order.create({company: companyA, rate: ownRate, rates: [ownRate], lines: [{rate: ownRate}]}));
        await expect(asA(() => Order.updateOne({_id: order._id}, {$set: {rate: foreignRate}}))).rejects.toMatchObject(refused);
        await expect(asA(() => Order.updateOne({_id: order._id}, {rate: foreignRate}))).rejects.toMatchObject(refused);
        await expect(asA(() => Order.findByIdAndUpdate(order._id, {$set: {"lines.0.rate": foreignRate}}))).rejects.toMatchObject(refused);
        await expect(asA(() => Order.updateOne({_id: order._id}, {$push: {rates: foreignRate}}))).rejects.toMatchObject(refused);
        await expect(asA(() => Order.updateOne({_id: order._id}, {$addToSet: {rates: {$each: [otherOwnRate, foreignRate]}}}))).rejects.toMatchObject(refused);
        await expect(asA(() => Order.updateMany({}, {$set: {lines: [{rate: foreignRate}]}}))).rejects.toMatchObject(refused);
        await expect(asA(() => Order.replaceOne({_id: order._id}, {company: companyA, rate: foreignRate}))).rejects.toMatchObject(refused);

        await asA(() => Order.updateOne({_id: order._id}, {$set: {rate: otherOwnRate}, $push: {rates: otherOwnRate}}));
        const stored = await asA(() => Order.findById(order._id));
        expect([stored!.rate, stored!.rates]).toEqual([otherOwnRate, [ownRate, otherOwnRate]]);
    });

    it("judges a cross-tenant update by the companies of the records it changes", async () => {
        await asA(() => Order.create({company: companyA, note: "a"}));
        await expect(asCrossTenant("a sweep", () => Order.updateMany({note: "a"}, {$set: {rate: foreignRate}}))).rejects.toMatchObject(refused);
        await expect(asCrossTenant("a sweep", () => Order.updateMany({note: "a"}, {$set: {rate: ownRate}}))).resolves.toBeTruthy();
    });

    it("refuses a foreign row written in another company's name", async () => {
        await expect(asCrossTenant("a sweep", () => Order.create({company: companyA, rate: foreignRate}))).rejects.toMatchObject(refused);
    });
});

describe("cost", () => {
    it("looks nothing up when no reference changed", async () => {
        const order = await asA(() => Order.create({company: companyA, rate: ownRate, rates: [ownRate], lines: [{rate: ownRate}]}));
        const loaded = await asA(() => Order.findById(order._id).populate("rate"));
        const lookups = vi.spyOn(Rate.collection, "find");
        loaded!.note = "changed";
        loaded!.lines![0].quantity = 3;
        await asA(() => loaded!.save());
        await asA(() => Order.updateOne({_id: order._id}, {$set: {note: "again"}}));
        expect(lookups).not.toHaveBeenCalled();
    });

    it("looks each target model up once per write", async () => {
        const lookups = vi.spyOn(Rate.collection, "find");
        await asA(() => Order.create({company: companyA, rate: ownRate, rates: [ownRate, otherOwnRate], lines: [{rate: otherOwnRate}], address: {rate: ownRate}}));
        expect(lookups).toHaveBeenCalledTimes(1);
    });
});

describe("allowForeignReferences", () => {
    const allowance = {reason: "a test flow that stores another company's rate", fields: ["TenantRefOrder.rate"]};

    it("lets the named fields point at another company and keeps checking the rest", async () => {
        await expect(asA(() => allowForeignReferences(allowance, () => Order.create({company: companyA, rate: foreignRate})))).resolves.toBeTruthy();
        await expect(asA(() => allowForeignReferences(allowance, () => Order.create({company: companyA, rates: [foreignRate]})))).rejects.toMatchObject(refused);
        await expect(asA(() => Order.create({company: companyA, rate: foreignRate}))).rejects.toMatchObject(refused);
    });
});

describe("update pipelines (TD-B108)", () => {
    it("checks literal ids set by $set / $addFields, $literal included", async () => {
        const order = await asA(() => Order.create({company: companyA, rate: ownRate}));
        await expect(asA(() => Order.updateOne({_id: order._id}, [{$set: {rate: foreignRate}}]))).rejects.toMatchObject(refused);
        await expect(asA(() => Order.updateOne({_id: order._id}, [{$addFields: {lines: [{rate: {$literal: foreignRate}}]}}]))).rejects.toMatchObject(refused);
        await asA(() => Order.updateOne({_id: order._id}, [{$set: {rate: otherOwnRate, note: {$concat: ["$note", "!"]}}}]));
        expect((await asA(() => Order.findById(order._id)))!.rate).toEqual(otherOwnRate);
    });

    it("refuses a computed reference with a developer error", async () => {
        const order = await asA(() => Order.create({company: companyA, rate: ownRate}));
        await expect(asA(() => Order.updateOne({_id: order._id}, [{$set: {rate: "$owner"}}]))).rejects.toThrow(/TenantRefOrder\.rate: an update pipeline/);
        await expect(asA(() => Order.updateOne({_id: order._id}, [{$set: {rates: {$concatArrays: ["$rates", [foreignRate]]}}}]))).rejects.toThrow(/D104/);
        await expect(asA(() => Order.updateOne({_id: order._id}, [{$set: {address: {rate: "$rate"}}}]))).rejects.toThrow(/TenantRefOrder\.address\.rate/);
        await expect(asA(() => Order.updateOne({_id: order._id}, [{$replaceWith: {company: companyA}}]))).rejects.toThrow(/\$replaceWith/);
    });
});

describe("bulkWrite (TD-B108)", () => {
    it("checks inserted, updated and replacing documents", async () => {
        const order = await asA(() => Order.create({company: companyA, rate: ownRate}));
        await expect(asA(() => Order.bulkWrite([{insertOne: {document: {company: companyA, rate: foreignRate}}}]))).rejects.toMatchObject(refused);
        await expect(asA(() => Order.bulkWrite([{updateOne: {filter: {_id: order._id}, update: {$set: {rate: foreignRate}}}}]))).rejects.toMatchObject(refused);
        await expect(asA(() => Order.bulkWrite([{updateMany: {filter: {company: companyA}, update: {$push: {rates: foreignRate}}}}]))).rejects.toMatchObject(refused);
        await expect(asA(() => Order.bulkWrite([{replaceOne: {filter: {_id: order._id}, replacement: {company: companyA, rate: foreignRate}}}]))).rejects.toMatchObject(refused);
        await expect(asA(() => Order.bulkWrite([{updateOne: {filter: {_id: order._id}, update: [{$set: {rate: "$owner"}}]}}]))).rejects.toThrow(/D104/);
        expect(await asA(() => Order.countDocuments({}))).toBe(1);

        await asA(() => Order.bulkWrite([
            {insertOne: {document: {company: companyA, rate: otherOwnRate}}},
            {updateOne: {filter: {_id: order._id}, update: {$set: {rate: otherOwnRate}}}},
        ]));
        expect((await asA(() => Order.findById(order._id)))!.rate).toEqual(otherOwnRate);
    });

    it("judges a cross-tenant update by the companies its filter matches; a tenant's batch stays in the tenant (TD-B114)", async () => {
        const order = await asCrossTenant("fixture", () => Order.create({company: companyB}));
        // Company A's request, a filter naming company B's record: the tenant scope narrows it to A, so it matches nothing.
        await asA(() => Order.bulkWrite([{updateOne: {filter: {_id: order._id}, update: {$set: {rate: ownRate}}}}]));
        expect((await asCrossTenant("check", () => Order.findById(order._id)))!.rate).toBeUndefined();
        // A sweep is judged by the record it matches: A's rate is foreign to B's record, B's own rate is not.
        await expect(asCrossTenant("a sweep", () => Order.bulkWrite([{updateOne: {filter: {_id: order._id}, update: {$set: {rate: ownRate}}}}]))).rejects.toMatchObject(refused);
        await asCrossTenant("a sweep", () => Order.bulkWrite([{updateOne: {filter: {_id: order._id}, update: {$set: {rate: foreignRate}}}}]));
    });

    it("looks each target model up once per batch, and not at all when no reference is set", async () => {
        const lookups = vi.spyOn(Rate.collection, "find");
        await asA(() => Order.bulkWrite([
            {insertOne: {document: {company: companyA, rate: ownRate}}},
            {insertOne: {document: {company: companyA, rates: [otherOwnRate]}}},
            {updateMany: {filter: {company: companyA}, update: {$set: {address: {rate: ownRate}}}}},
        ]));
        expect(lookups).toHaveBeenCalledTimes(1);
        await asA(() => Order.bulkWrite([{updateMany: {filter: {company: companyA}, update: {$set: {note: "x"}}}}]));
        expect(lookups).toHaveBeenCalledTimes(1);
    });
});

describe("records without the tenant scope (TD-B109)", () => {
    it("judges a record by its own _id when its references must be its own rows", async () => {
        const recordId = new ObjectId();
        const [ownToRecord] = await asCrossTenant("fixture", () => Rate.create([{code: "ALL", company: recordId}]));
        const [shared] = await asCrossTenant("fixture", () => SharedFile.create([{title: "logo", company: companyB, sharedWith: [recordId]}]));
        await expect(OwnRecord.create({_id: recordId, rate: ownRate})).rejects.toMatchObject(refused);
        await expect(OwnRecord.create({_id: recordId, rate: ownToRecord._id, file: shared._id})).resolves.toBeTruthy();
        await expect(OwnRecord.updateOne({_id: recordId}, {$set: {rate: foreignRate}})).rejects.toMatchObject(refused);
        await expect(OwnRecord.bulkWrite([{updateOne: {filter: {_id: recordId}, update: {$set: {rate: ownRate}}}}])).rejects.toMatchObject(refused);
    });

    it("judges each entry by its own company", async () => {
        const member = await Member.create({memberships: [{company: companyA, rates: [ownRate]}, {company: companyB, rates: [foreignRate]}]});
        await expect(Member.create({memberships: [{company: companyA, rates: [foreignRate]}]})).rejects.toMatchObject(refused);

        member.memberships[0].rates.push(foreignRate);
        await expect(member.save()).rejects.toMatchObject(refused);
        await expect(Member.updateOne({_id: member._id}, {$push: {memberships: {company: companyB, rates: [ownRate]}}})).rejects.toMatchObject(refused);
        await expect(Member.updateOne({_id: member._id}, {$set: {memberships: [{company: companyB, rates: [otherOwnRate]}]}})).rejects.toMatchObject(refused);
        await Member.updateOne({_id: member._id}, {$push: {memberships: {company: companyA, rates: [otherOwnRate]}}});
        expect((await Member.findById(member._id))!.memberships).toHaveLength(3);
    });

    it("refuses an entry's reference written without the entry's company", async () => {
        const member = await Member.create({memberships: [{company: companyA, rates: [ownRate]}]});
        await expect(Member.updateOne({_id: member._id}, {$set: {"memberships.0.rates": [otherOwnRate]}})).rejects.toThrow(/whole memberships entry/);
        // Fields of an entry that hold no reference, and removing one, stay open.
        await Member.updateOne({_id: member._id}, {$set: {"memberships.$[m].note": "x"}}, {arrayFilters: [{"m.company": companyA}]});
        await Member.updateOne({_id: member._id}, {$pull: {"memberships.$[].rates": ownRate}});
        expect((await Member.findById(member._id))!.memberships[0].rates).toEqual([]);
    });

    it("applies to Company (its own logo; places are platform lists) and User (each membership's roles)", async () => {
        const [{insertedId: roleA}, {insertedId: roleB}, {insertedId: countryB}, {insertedId: mediaB}] = await Promise.all([
            Role.collection.insertOne({company: companyA, name: "A"}),
            Role.collection.insertOne({company: companyB, name: "B"}),
            Country.collection.insertOne({company: companyB, code: "CH"}),
            Media.collection.insertOne({company: companyB}),
        ]);
        await expect(Company.updateOne({_id: companyA}, {$set: {logo: mediaB}})).rejects.toMatchObject(refused);
        // A country is a platform row every company names (D160), whoever owns it.
        await expect(Company.updateOne({_id: companyA}, {$set: {addresses: [{street: "s", postalCode: "1", city: new ObjectId(), country: countryB}]}}))
            .resolves.toBeTruthy();
        // Its own logo; publicMediaPlugin then marks it public inside that company's scope.
        await expect(requestContext.run({tenantCompanyId: companyB.toString()}, async () => await Company.updateOne({_id: companyB}, {$set: {logo: mediaB}}))).resolves.toBeTruthy();

        const userId = new ObjectId();
        await expect(User.updateOne({_id: userId}, {$push: {roles: {company: companyA, roles: [roleB], rolesCount: 1}}}))
            .rejects.toMatchObject({...refused, content: ["User.roles.roles"]});
        await expect(User.updateOne({_id: userId}, {$push: {roles: {company: companyA, roles: [roleA], rolesCount: 1}}})).resolves.toBeTruthy();
    });
});
