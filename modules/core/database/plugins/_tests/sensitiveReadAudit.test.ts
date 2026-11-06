import {afterAll, beforeAll, beforeEach, describe, expect, it} from "vitest";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";
import mongoose, {Schema} from "mongoose";
import {ObjectId} from "mongodb";
import auditPlugin from "@coreModule/database/plugins/auditPlugin";
import AuditLog from "@coreModule/database/schemas/auditLog/auditLog";
import {requestContext, type RequestContextStore} from "@coreModule/utilities/endpoints/requestContext";
import {asCrossTenant} from "@coreModule/utilities/endpoints/tenantScope";
import {redactDiff} from "@coreModule/domain/ai/tools/auditAndSecurityTools";

const chartSchema = new Schema({
    company: {type: Schema.Types.ObjectId},
    title: String,
    history: {type: {notes: String}, sensitivity: "health"},
});
auditPlugin(chartSchema);
const Chart = mongoose.model("SensitiveReadChart", chartSchema);

const company = new ObjectId();
const reader = new ObjectId();
let chartId: ObjectId;
let emptyChartId: ObjectId;

const asUser = <T>(fn: () => Promise<T>, store: RequestContextStore = {tenantCompanyId: company.toString(), actionUserCtx: {userId: reader.toString()}}) =>
    requestContext.run(store, fn);
const reads = () => asCrossTenant("test reads every audit entry", () => AuditLog.find({action: "READ"}).lean());

beforeAll(async () => {
    await connectTestDatabase();
    const [chart, empty] = await Chart.insertMany([
        {company, title: "A", history: {notes: "allergic to penicillin"}},
        {company, title: "B"},
    ]);
    chartId = chart._id;
    emptyChartId = empty._id;
}, 120000);

afterAll(async () => {
    await disconnectTestDatabase();
});

beforeEach(async () => {
    await asCrossTenant("test cleanup", () => AuditLog.deleteMany({}));
});

describe("sensitive read audit (SEC-06, D56)", () => {
    it("records who opened which sensitive fields of which record, once per request, without the values", async () => {
        await asUser(async () => {
            await Chart.findOne({_id: chartId}).select("title history");
            await Chart.findOne({_id: chartId}).select("title history").lean();
        });
        const entries = await reads();
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({collectionName: Chart.collection.name, action: "READ", diff: {history: {from: null, to: null}}});
        expect(String(entries[0]!.documentId)).toBe(String(chartId));
        expect(String(entries[0]!.actorId)).toBe(String(reader));
        expect(JSON.stringify(entries[0])).not.toContain("penicillin");
    });

    it("records nothing when the field is not asked for, is empty, is loaded whole by code, or nobody is signed in", async () => {
        await asUser(async () => {
            await Chart.findOne({_id: chartId}).select("title");
            await Chart.findOne({_id: emptyChartId}).select("title history");
            await Chart.findById(chartId); // a service loading the whole document for its own logic
        });
        await asUser(() => Chart.findOne({_id: chartId}).select("history").exec(), {tenantCompanyId: company.toString()});
        expect(await reads()).toHaveLength(0);
    });

    it("keeps sensitive values from the assistant's audit search (SEC-07)", () => {
        const {changes, redactedFields} = redactDiff(
            {history: {from: null, to: {notes: "diabetic"}}, title: {from: "A", to: "B"}},
            Chart.collection.name,
        );
        expect(redactedFields).toEqual(["history"]);
        expect(JSON.stringify(changes)).not.toContain("diabetic");
        expect(changes).toContainEqual({field: "title", from: "A", to: "B"});
    });
});
