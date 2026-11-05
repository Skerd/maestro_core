import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {MongoMemoryReplSet} from "mongodb-memory-server";
import mongoose, {Document, Schema, Types} from "mongoose";
import ownershipPlugin from "@coreModule/database/plugins/ownershipPlugin";
import auditPlugin from "@coreModule/database/plugins/auditPlugin";
import softDeletePlugin from "@coreModule/database/plugins/softDeletePlugin";
import lifeCyclePlugin from "@coreModule/database/plugins/lifeCyclePlugin";
import AuditLog from "@coreModule/database/schemas/auditLog/auditLog";
import {asCrossTenant, withTenant} from "@coreModule/utilities/endpoints/tenantScope";
import {requestContext} from "@coreModule/utilities/endpoints/requestContext";
import Company from "@coreModule/database/schemas/company/company";

interface IThing extends Document {title?: string; company: Types.ObjectId}
const schema = new Schema<IThing>({title: String});
ownershipPlugin(schema);
auditPlugin(schema);
softDeletePlugin(schema);
lifeCyclePlugin(schema);
const Thing = mongoose.model<IThing>("AuditCreateThing", schema);
const company = new Types.ObjectId();
let replSet: MongoMemoryReplSet;

beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({replSet: {count: 1, storageEngine: "wiredTiger"}});
    await mongoose.connect(replSet.getUri());
    await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
}, 120000);

afterAll(async () => {
    await mongoose.disconnect();
    await replSet.stop();
});

describe("audit of a create (TD-B36)", {timeout: 60000}, () => {
    // The CRUD create hands the request's company document to `company`, so Mongoose holds it as populated.
    it("records CREATE for a document created in a request's transaction, with the request's company document", async () => {
        const session = await mongoose.startSession();
        let id: unknown;
        await requestContext.run({tenantCompanyId: company.toString(), actionUserCtx: {userId: new Types.ObjectId().toString(), orgId: company.toString()}}, async () => {
            session.startTransaction();
            const requestCompany = new Company({_id: company, name: "Request company"});
            // What BaseCrudService.create does with the CRUD create's payload: the company document goes in as is.
            const doc = new Thing({title: "probe"});
            doc.set("company", requestCompany);
            expect(doc.populated("company")).toBeTruthy();
            await doc.save({session});
            id = doc._id;
            await session.commitTransaction();
        });
        await session.endSession();
        const entries = await asCrossTenant("test reads audit", () => AuditLog.find({documentId: id}).lean());
        expect(entries.map((entry) => entry.action)).toContain("CREATE");
    });
});
