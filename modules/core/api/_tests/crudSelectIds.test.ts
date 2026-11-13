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
import * as userSessionRoute from "@coreModule/api/user/private/userSession";
import UserSession from "@coreModule/database/schemas/userSession/userSession";

interface IThing extends Document {title?: string; company: Types.ObjectId}
const schema = new Schema<IThing>({title: String});
ownershipPlugin(schema);
auditPlugin(schema);
softDeletePlugin(schema);
lifeCyclePlugin(schema);
const Thing = mongoose.model<IThing>("CrudSelectIdsThing", schema);
normalizeSchemaPermissions(Thing);
addModelData(Thing);
const thingService = new BaseCrudService<IThing, typeof Thing>(Thing, "CrudSelectIdsThing");

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
    selectSearchField: "title",
});
const app = appFor([{basePath: "/api/things", router}]);

const companyId = new Types.ObjectId().toString();
const otherCompanyId = new Types.ObjectId().toString();
const caller: TestCaller = {userId: new Types.ObjectId().toString(), companyId, permissions: allPermissionTags([Thing])};
const select = (body: Record<string, unknown>) => request(app).post("/api/things/select").set(callerHeader(caller)).send(body);

const titles = ["Alpha", "Bravo", "Charlie", "Delta"];
const ids: string[] = [];
let foreignId = "";

beforeAll(async () => {
    await connectTestDatabase();
    for (const title of titles) {
        const [doc] = await Thing.collection.insertMany([{title, company: new Types.ObjectId(companyId)}]).then((r) => Object.values(r.insertedIds));
        ids.push(doc.toString());
    }
    const foreign = await Thing.collection.insertOne({title: "Foreign", company: new Types.ObjectId(otherCompanyId)});
    foreignId = foreign.insertedId.toString();
}, 120000);

afterAll(async () => {
    await disconnectTestDatabase();
});

describe("createCrudRouter select by ids (TD-F70, TD-F71)", {timeout: 60000}, () => {
    it("returns the asked records past the first page, ignoring the search", async () => {
        const firstPage = await select({page: 1, limit: 2});
        expect(firstPage.status).toBe(200);
        expect(firstPage.body.data.map((o: {label: string}) => o.label)).toEqual(["Alpha", "Bravo"]);

        const byId = await select({page: 1, limit: 2, name: "Alpha", ids: [ids[3]]});
        expect(byId.status).toBe(200);
        expect(byId.body.data).toEqual([{value: ids[3], label: "Delta"}]);
        expect(byId.body.total).toBe(1);
    });

    it("never labels another company's record", async () => {
        const res = await select({page: 1, limit: 5, ids: [foreignId, ids[0]]});
        expect(res.status).toBe(200);
        expect(res.body.data.map((o: {label: string}) => o.label)).toEqual(["Alpha"]);
    });

    it("refuses ids that are not object ids", async () => {
        const res = await select({page: 1, limit: 5, ids: [{$ne: null}]});
        expect(res.status).toBe(400);
    });
});

describe("a custom select handler honours ids too (TD-B217)", {timeout: 60000}, () => {
    const sessionApp = appFor([userSessionRoute]);
    const sessionCaller: TestCaller = {userId: new Types.ObjectId().toString(), companyId, permissions: allPermissionTags([UserSession])};
    const selectSessions = (body: Record<string, unknown>) =>
        request(sessionApp).post("/api/user/userSession/select").set(callerHeader(sessionCaller)).send(body);

    it("labels a session past the first page and outside the user the form narrows to, never another company's", async () => {
        const user = new Types.ObjectId();
        const rows = ["s-1", "s-2", "s-3"].map((sessionId, index) => ({
            sessionId, deviceId: `d-${index + 1}`, user, isActive: true, lastActiveAt: new Date(2026, 0, 10 - index),
            company: new Types.ObjectId(companyId), deletedAt: null,
        }));
        const inserted = Object.values((await UserSession.collection.insertMany(rows)).insertedIds).map(String);
        const foreign = (await UserSession.collection.insertOne({sessionId: "s-x", deviceId: "d-x", user, isActive: true, company: new Types.ObjectId(otherCompanyId), deletedAt: null})).insertedId.toString();

        const firstPage = await selectSessions({page: 1, limit: 1});
        expect(firstPage.status).toBe(200);
        expect(firstPage.body.data).toEqual([{value: inserted[0], label: "s-1 — d-1"}]);

        const byId = await selectSessions({page: 1, limit: 1, name: "s-1", userId: new Types.ObjectId().toString(), ids: [inserted[2], foreign]});
        expect(byId.status).toBe(200);
        expect(byId.body.data).toEqual([{value: inserted[2], label: "s-3 — d-3"}]);
    });
});
