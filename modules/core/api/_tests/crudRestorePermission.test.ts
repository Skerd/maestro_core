import {afterAll, beforeAll, describe, expect, it, vi} from "vitest";
import mongoose, {Document, Schema, Types} from "mongoose";
import request from "supertest";

vi.mock("@coreModule/utilities/middlewares/authMW", async () => (await import("@coreModule/_tests/httpHarness")).authMWStub);

import {allPermissionTags, appFor, callerHeader, type TestCaller} from "@coreModule/_tests/httpHarness";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";
import {createCrudRouter} from "@coreModule/api/crudRouterFactory";
import {BaseCrudService} from "@coreModule/database/services/baseCrudService";
import {normalizeSchemaPermissions} from "@coreModule/database/utilities";
import ownershipPlugin from "@coreModule/database/plugins/ownershipPlugin";
import auditPlugin from "@coreModule/database/plugins/auditPlugin";
import softDeletePlugin from "@coreModule/database/plugins/softDeletePlugin";
import lifeCyclePlugin from "@coreModule/database/plugins/lifeCyclePlugin";
import {validateSingleForm} from "armonia/src/modules/core/utilities/zod/shared.validator";

interface IThing extends Document {title?: string; company: Types.ObjectId}
const schema = new Schema<IThing>({title: String});
ownershipPlugin(schema);
auditPlugin(schema);
softDeletePlugin(schema);
lifeCyclePlugin(schema);
const Thing = mongoose.model<IThing>("CrudRestorePermissionThing", schema);
normalizeSchemaPermissions(Thing);
const thingService = new BaseCrudService<IThing, typeof Thing>(Thing, "CrudRestorePermissionThing");

const overrideCalls: string[] = [];
const {router} = createCrudRouter<IThing>({
    collectionName: Thing.collection.name,
    model: Thing,
    service: thingService,
    createSchema: validateSingleForm,
    editSchema: validateSingleForm,
    toDTO: (doc) => ({_id: doc._id.toString()}),
    toDTOArray: (docs) => docs.map((doc) => ({_id: doc._id.toString()})),
    toSelect: (docs) => docs.map((doc) => ({value: doc._id.toString(), label: doc.title ?? ""})),
    buildCreateData: () => ({}),
    buildUpdateData: () => ({}),
    overrideRestoreHandler: async ({_id}) => {
        overrideCalls.push(_id);
        return {message: "restored by the override"};
    },
});
const app = appFor([{basePath: "/api/things", router}]);

const companyId = new Types.ObjectId().toString();
const allTags = allPermissionTags([Thing]);
const caller = (permissions: string[]): TestCaller => ({userId: new Types.ObjectId().toString(), companyId, permissions});
const restore = (permissions: string[], _id: string) =>
    request(app).patch("/api/things/restore").set(callerHeader(caller(permissions))).send({_id});

beforeAll(async () => {
    await connectTestDatabase();
}, 120000);

afterAll(async () => {
    await disconnectTestDatabase();
});

describe("createCrudRouter restore override (CORE-04, TD-M05)", {timeout: 60000}, () => {
    it("checks the model's restore permission before an override runs", async () => {
        const id = new Types.ObjectId().toString();
        const withoutRestore = allTags.filter((tag) => !tag.includes("restore"));
        expect(withoutRestore.length).toBeLessThan(allTags.length);

        const refused = await restore(withoutRestore, id);
        expect(refused.status).toBe(403);
        expect(refused.body.error_code).toBe("user_permissions_not_sufficient");
        expect(overrideCalls).toEqual([]);

        const allowed = await restore(allTags, id);
        expect(allowed.status).toBe(200);
        expect(allowed.body.message).toBe("restored by the override");
        expect(overrideCalls).toEqual([id]);
    });
});
