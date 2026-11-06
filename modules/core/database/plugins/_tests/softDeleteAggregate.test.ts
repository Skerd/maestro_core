import {afterAll, beforeAll, beforeEach, describe, expect, it} from "vitest";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";
import mongoose, {Schema} from "mongoose";
import {ObjectId} from "mongodb";
import {ownershipPlugin} from "../ownershipPlugin";
import {softDeletePlugin} from "../softDeletePlugin";
import {requestContext} from "@coreModule/utilities/endpoints/requestContext";
import {asCrossTenant} from "@coreModule/utilities/endpoints/tenantScope";

/* D15: aggregations leave soft-deleted documents out, like find does. */

interface IInvoice {
    title: string;
    company: ObjectId;
    deletedAt?: Date | null;
}

// The order every module schema uses.
const invoiceSchema = new Schema<IInvoice>({title: String});
ownershipPlugin(invoiceSchema);
softDeletePlugin(invoiceSchema);
const Invoice = mongoose.model<IInvoice>("SoftDeleteAggregateInvoice", invoiceSchema);

const companyA = new ObjectId();
const companyB = new ObjectId();

/** Runs `fn` like a request of `company`, as an admin (who sees deleted documents in find). */
const asAdmin = <T>(company: ObjectId, fn: () => PromiseLike<T>) =>
    requestContext.run({tenantCompanyId: company.toString(), actionUserCtx: {isAdmin: true}}, async () => await fn());

const titles = (rows: {title: string}[]) => rows.map((row) => row.title).sort();

beforeAll(async () => {
    await connectTestDatabase();
});

afterAll(async () => {
    await disconnectTestDatabase();
});

beforeEach(async () => {
    await asCrossTenant("test fixtures", async () => {
        await Invoice.collection.deleteMany({});
        await Invoice.collection.insertMany([
            {title: "live", company: companyA},
            {title: "restored", company: companyA, deletedAt: null},
            {title: "deleted", company: companyA, deletedAt: new Date()},
            {title: "other", company: companyB},
        ]);
    });
});

describe("softDeletePlugin on aggregate (D15)", () => {
    it("leaves deleted documents out of a pipeline, for an admin too", async () => {
        // An admin's find shows them (to restore them); a total never counts them.
        expect(titles(await asAdmin(companyA, () => Invoice.find().lean()))).toEqual(["deleted", "live", "restored"]);
        expect(titles(await asAdmin(companyA, () => Invoice.aggregate<{title: string}>([{$sort: {title: 1}}])))).toEqual(["live", "restored"]);
    });

    it("adds to the caller's first $match without hiding its company from the tenant scope", async () => {
        const rows = await asAdmin(companyA, () => Invoice.aggregate<{title: string}>([{$match: {title: {$ne: "x"}}}]));
        expect(titles(rows)).toEqual(["live", "restored"]);
        await expect(asAdmin(companyA, () => Invoice.aggregate([{$match: {company: companyB}}]))).rejects.toMatchObject({error_code: "tenant_scope_violation"});
    });

    it("keeps a deletedAt condition the caller wrote", async () => {
        const rows = await asAdmin(companyA, () => Invoice.aggregate<{title: string}>([{$match: {deletedAt: {$ne: null}}}]));
        expect(titles(rows)).toEqual(["deleted"]);
    });

    it("keeps deleted documents with the withDeleted option, which never reaches the server", async () => {
        const aggregation = Invoice.aggregate<{title: string}>([{$match: {}}]).option({withDeleted: true});
        expect(titles(await asAdmin(companyA, () => aggregation.exec()))).toEqual(["deleted", "live", "restored"]);
        expect(aggregation.options.withDeleted).toBeUndefined();
    });
});
