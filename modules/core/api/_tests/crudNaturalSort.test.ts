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
import auditPlugin from "@coreModule/database/plugins/auditPlugin";
import softDeletePlugin from "@coreModule/database/plugins/softDeletePlugin";
import lifeCyclePlugin from "@coreModule/database/plugins/lifeCyclePlugin";
import {validateSingleForm} from "armonia/src/modules/core/utilities/zod/shared.validator";

interface IRoom extends Document {title?: string; company: Types.ObjectId}
const schema = new Schema<IRoom>({title: String});
ownershipPlugin(schema);
auditPlugin(schema);
softDeletePlugin(schema);
lifeCyclePlugin(schema);
const Room = mongoose.model<IRoom>("CrudNaturalSortRoom", schema);
normalizeSchemaPermissions(Room);
addModelData(Room);
const roomService = new BaseCrudService<IRoom, typeof Room>(Room, "CrudNaturalSortRoom");

/** Two routers on the same rows: one plain, one with `naturalSort` (D165). */
const routerFor = (naturalSort: boolean) => createCrudRouter<IRoom>({
    collectionName: Room.collection.name,
    model: Room,
    service: roomService,
    createSchema: validateSingleForm,
    editSchema: validateSingleForm,
    toDTO: (doc) => ({_id: doc._id.toString(), title: doc.title}),
    toDTOArray: (docs) => docs.map((doc) => ({_id: doc._id.toString(), title: doc.title})),
    toSelect: (docs) => docs.map((doc) => ({value: doc._id.toString(), label: doc.title ?? ""})),
    buildCreateData: () => ({}),
    buildUpdateData: () => ({}),
    selectSearchField: "title",
    defaultSort: {title: 1},
    naturalSort,
}).router;
const app = appFor([
    {basePath: "/api/rooms", router: routerFor(false)},
    {basePath: "/api/naturalRooms", router: routerFor(true)},
]);

const companyId = new Types.ObjectId().toString();
const caller: TestCaller = {userId: new Types.ObjectId().toString(), companyId, permissions: allPermissionTags([Room])};
const post = (url: string, body: Record<string, unknown>) => request(app).post(url).set(callerHeader(caller)).send(body);

beforeAll(async () => {
    await connectTestDatabase();
    await Room.collection.insertMany(
        ["A-01 Floor 10", "A-01 Floor 2", "A-01 Floor 1", "A-02 Floor 1"].map((title) => ({title, company: new Types.ObjectId(companyId)})),
    );
}, 120000);

afterAll(async () => {
    await disconnectTestDatabase();
});

describe("createCrudRouter naturalSort (D165)", () => {
    it("a plain list sorts text character by character", async () => {
        const res = await post("/api/rooms", {offset: 0, limit: 10});
        expect(res.status).toBe(200);
        expect(res.body.data.map((row: {title: string}) => row.title)).toEqual(["A-01 Floor 1", "A-01 Floor 10", "A-01 Floor 2", "A-02 Floor 1"]);
    });

    it("the list orders the numbers in the text by value", async () => {
        const res = await post("/api/naturalRooms", {offset: 0, limit: 10});
        expect(res.status).toBe(200);
        expect(res.body.data.map((row: {title: string}) => row.title)).toEqual(["A-01 Floor 1", "A-01 Floor 2", "A-01 Floor 10", "A-02 Floor 1"]);
    });

    it("so does a column the user sorts by, and the select", async () => {
        const list = await post("/api/naturalRooms", {offset: 0, limit: 10, sortBy: "title", sortOrder: "desc"});
        expect(list.body.data.map((row: {title: string}) => row.title)).toEqual(["A-02 Floor 1", "A-01 Floor 10", "A-01 Floor 2", "A-01 Floor 1"]);
        const select = await post("/api/naturalRooms/select", {page: 1, limit: 10});
        expect(select.status).toBe(200);
        expect(select.body.data.map((option: {label: string}) => option.label)).toEqual(["A-01 Floor 1", "A-01 Floor 2", "A-01 Floor 10", "A-02 Floor 1"]);
    });
});
