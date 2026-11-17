import {afterAll, beforeAll, describe, expect, it, vi} from "vitest";
import mongoose, {Document, Schema, Types} from "mongoose";
import request from "supertest";

vi.mock("@coreModule/utilities/middlewares/authMW", async () => (await import("@coreModule/_tests/httpHarness")).authMWStub);

import {allPermissionTags, appFor, callerHeader, type TestCaller} from "@coreModule/_tests/httpHarness";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";
import {createCrudRouter} from "@coreModule/api/crudRouterFactory";
import {BaseCrudService} from "@coreModule/database/services/baseCrudService";
import {normalizeSchemaPermissions} from "@coreModule/database/utilities";
import {addModelData} from "@coreModule/database/collections";
import ownershipPlugin from "@coreModule/database/plugins/ownershipPlugin";
import lifeCyclePlugin from "@coreModule/database/plugins/lifeCyclePlugin";
import {validateSingleForm} from "armonia/src/modules/core/utilities/zod/shared.validator";

interface IOwner extends Document {name: string; company: Types.ObjectId}
const ownerSchema = new Schema<IOwner>({name: String});
ownershipPlugin(ownerSchema);
const Owner = mongoose.model<IOwner>("CrudSelectPopulateOwner", ownerSchema);

interface IThing extends Document {title?: string; owner?: IOwner; company: Types.ObjectId}
const schema = new Schema<IThing>({title: String, owner: {type: Schema.Types.ObjectId, ref: "CrudSelectPopulateOwner"}});
ownershipPlugin(schema);
lifeCyclePlugin(schema);
const Thing = mongoose.model<IThing>("CrudSelectPopulateThing", schema);
normalizeSchemaPermissions(Thing);
addModelData(Thing);
const thingService = new BaseCrudService<IThing, typeof Thing>(Thing, "CrudSelectPopulateThing");

const {router} = createCrudRouter<IThing>({
    collectionName: Thing.collection.name,
    model: Thing,
    service: thingService,
    createSchema: validateSingleForm,
    editSchema: validateSingleForm,
    toDTO: (doc) => ({_id: doc._id.toString()}),
    toDTOArray: (docs) => docs.map((doc) => ({_id: doc._id.toString()})),
    toSelect: (docs) => docs.map((doc) => ({value: doc._id.toString(), label: `${doc.title} · ${doc.owner?.name ?? "?"}`})),
    buildCreateData: () => ({}),
    buildUpdateData: () => ({}),
    selectSearchField: "title",
    selectProjection: "_id title owner",
    selectPopulate: [{path: "owner", select: "name"}],
});
const app = appFor([{basePath: "/api/things", router}]);

const companyId = new Types.ObjectId();
const caller: TestCaller = {userId: new Types.ObjectId().toString(), companyId: companyId.toString(), permissions: allPermissionTags([Thing])};

beforeAll(async () => {
    await connectTestDatabase();
    const owner = await Owner.collection.insertOne({name: "Dr. Ana", company: companyId});
    await Thing.collection.insertOne({title: "Time off", owner: owner.insertedId, company: companyId});
}, 120000);

afterAll(async () => {
    await disconnectTestDatabase();
});

// TD-B242: a select label could not name a linked record (a dental time off read as a raw timestamp).
describe("createCrudRouter selectPopulate", {timeout: 60000}, () => {
    it("hands toSelect the populated reference", async () => {
        const res = await request(app).post("/api/things/select").set(callerHeader(caller)).send({page: 1, limit: 5});
        expect(res.status).toBe(200);
        expect(res.body.data.map((option: {label: string}) => option.label)).toEqual(["Time off · Dr. Ana"]);
    });
});
