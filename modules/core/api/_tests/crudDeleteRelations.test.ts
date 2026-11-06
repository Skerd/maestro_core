import {afterAll, beforeAll, describe, expect, it, vi} from "vitest";
import mongoose, {Document, Schema, Types} from "mongoose";
import request from "supertest";

vi.mock("@coreModule/utilities/middlewares/authMW", async () => (await import("@coreModule/_tests/httpHarness")).authMWStub);

import {allPermissionTags, appFor, callerHeader} from "@coreModule/_tests/httpHarness";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";
import {createCrudRouter} from "@coreModule/api/crudRouterFactory";
import {BaseCrudService} from "@coreModule/database/services/baseCrudService";
import {addModelData} from "@coreModule/database/collections";
import {normalizeSchemaPermissions} from "@coreModule/database/utilities";
import ownershipPlugin from "@coreModule/database/plugins/ownershipPlugin";
import auditPlugin from "@coreModule/database/plugins/auditPlugin";
import softDeletePlugin from "@coreModule/database/plugins/softDeletePlugin";
import lifeCyclePlugin from "@coreModule/database/plugins/lifeCyclePlugin";
import {withTenant} from "@coreModule/utilities/endpoints/tenantScope";
import {validateSingleForm} from "armonia/src/modules/core/utilities/zod/shared.validator";

function withPlugins(schema: Schema): Schema {
    ownershipPlugin(schema);
    auditPlugin(schema);
    softDeletePlugin(schema);
    lifeCyclePlugin(schema);
    return schema;
}

interface IParent extends Document {name?: string; company: Types.ObjectId}
interface IChild extends Document {parent: Types.ObjectId; company: Types.ObjectId}
const Parent = mongoose.model<IParent>("CrudDeleteParent", withPlugins(new Schema<IParent>({name: String})));
const Child = mongoose.model<IChild>("CrudDeleteChild", withPlugins(new Schema<IChild>({
    parent: {type: Schema.Types.ObjectId, ref: "CrudDeleteParent", required: true},
})));
normalizeSchemaPermissions(Parent);
normalizeSchemaPermissions(Child);
addModelData(Parent);
addModelData(Child);
const parentService = new BaseCrudService<IParent, typeof Parent>(Parent, "CrudDeleteParent");
const childService = new BaseCrudService<IChild, typeof Child>(Child, "CrudDeleteChild");

const base = {
    collectionName: Parent.collection.name,
    model: Parent,
    service: parentService,
    createSchema: validateSingleForm,
    editSchema: validateSingleForm,
    toDTO: (doc: IParent) => ({_id: doc._id.toString()}),
    toDTOArray: (docs: IParent[]) => docs.map((doc) => ({_id: doc._id.toString()})),
    toSelect: (docs: IParent[]) => docs.map((doc) => ({value: doc._id.toString(), label: doc.name ?? ""})),
    buildCreateData: () => ({}),
    buildUpdateData: () => ({}),
};
const hookCalls: string[] = [];
// An empty beforeDelete used to switch the relation check off.
const plain = createCrudRouter<IParent>({...base, beforeDelete: async () => {hookCalls.push("before");}});
const cascading = createCrudRouter<IParent>({
    ...base,
    afterDelete: async ({session}, doc) => {
        hookCalls.push("after");
        await childService.deleteMany({parent: doc._id}, {session});
    },
});
const app = appFor([{basePath: "/api/plain", router: plain.router}, {basePath: "/api/cascading", router: cascading.router}]);

const companyId = new Types.ObjectId();
const caller = {userId: new Types.ObjectId().toString(), companyId: companyId.toString(), permissions: allPermissionTags([Parent])};
const remove = (path: string, _id: Types.ObjectId) => request(app).delete(`/api/${path}`).set(callerHeader(caller)).send({_id: _id.toString()});

async function parentWithChild(): Promise<Types.ObjectId> {
    return withTenant(companyId, async () => {
        const parent = await Parent.create({name: "parent", company: companyId});
        await Child.create({parent: parent._id, company: companyId});
        return parent._id;
    });
}
const live = (model: typeof Parent | typeof Child, filter: Record<string, unknown>) =>
    withTenant(companyId, () => (model as typeof Parent).countDocuments({...filter, deletedAt: null}));

beforeAll(async () => {
    await connectTestDatabase();
}, 120000);

afterAll(async () => {
    await disconnectTestDatabase();
});

describe("createCrudRouter delete relation safety (CORE-04, D66)", {timeout: 60000}, () => {
    it("refuses a delete that leaves a live required reference, even with a beforeDelete hook", async () => {
        const id = await parentWithChild();
        const response = await remove("plain", id);
        expect(response.status).toBe(400);
        expect(response.body.error_code).toBe("cannot_delete_has_relations");
        // Names the blocking record type (D72).
        expect(response.body.message).toContain(`${Child.collection.name} (1)`);
        expect(response.body.content).toEqual([Child.collection.name]);
        expect(hookCalls).toContain("before");
        // Rolled back: the parent is still live.
        expect(await live(Parent, {_id: id})).toBe(1);
    });

    it("lets a delete through when its hooks remove the references in the same transaction", async () => {
        const id = await parentWithChild();
        const response = await remove("cascading", id);
        expect(response.status).toBe(200);
        expect(hookCalls).toContain("after");
        expect(await live(Parent, {_id: id})).toBe(0);
        expect(await live(Child, {parent: id})).toBe(0);
    });
});
