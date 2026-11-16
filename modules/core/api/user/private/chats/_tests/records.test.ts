import {afterAll, beforeAll, describe, expect, it, vi} from "vitest";
import mongoose, {Document, Schema, Types} from "mongoose";
import request from "supertest";

vi.mock("@coreModule/utilities/middlewares/authMW", async () => (await import("@coreModule/_tests/httpHarness")).authMWStub);

import {Router as ExpressRouter} from "express";
import authMW, {type AuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import {asyncHandler} from "@coreModule/utilities/middlewares/asyncHandler";
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
import {recordToken} from "armonia/src/modules/core/helpers/chatTokens";
import * as recordsRoute from "@coreModule/api/user/private/chats/records";
import {recordRefsToStore, visibleRecordRefs} from "@coreModule/domain/chat/chatRecords";

/* Core fixtures only (CORE-07): a kind of record served under core, one served under a module the company lacks, and
   one whose route hides some rows (its own select filter must hide them in chat too). */

interface IThing extends Document {title?: string; hidden?: boolean; company: Types.ObjectId}

function fixture(name: string, options: {hideHidden?: boolean} = {}) {
    const schema = new Schema<IThing>({title: String, hidden: Boolean});
    ownershipPlugin(schema);
    auditPlugin(schema);
    softDeletePlugin(schema);
    lifeCyclePlugin(schema);
    const model = mongoose.model<IThing>(name, schema);
    normalizeSchemaPermissions(model);
    addModelData(model);
    const {router} = createCrudRouter<IThing>({
        collectionName: model.collection.name,
        model,
        service: new BaseCrudService<IThing, typeof model>(model, name),
        createSchema: validateSingleForm,
        editSchema: validateSingleForm,
        toDTO: (doc) => ({_id: doc._id.toString()}),
        toDTOArray: (docs) => docs.map((doc) => ({_id: doc._id.toString()})),
        toSelect: (docs) => docs.map((doc) => ({value: doc._id.toString(), label: doc.title ?? ""})),
        buildCreateData: () => ({}),
        buildUpdateData: () => ({}),
        selectSearchField: "title",
        ...(options.hideHidden ? {extraSelectFilter: () => ({hidden: {$ne: true}})} : {}),
    });
    return {model, router};
}

const things = fixture("ChatRecordThing", {hideHidden: true});
const gadgets = fixture("ChatRecordGadget");
const offModule = fixture("ChatRecordOffModuleThing");
const THINGS = things.model.collection.name;
const GADGETS = gadgets.model.collection.name;
const OFF = offModule.model.collection.name;

/** Runs the message-side checks as the caller, the way the message routes do. */
const probe = ExpressRouter();
probe.post("/store", authMW("private"), asyncHandler(async (params: AuthenticatedMWType & {text: string; isPublicChat?: boolean}) =>
    ({refs: await recordRefsToStore(params, params.text, {isPublicChat: params.isPublicChat})})));
probe.post("/visible", authMW("private"), asyncHandler(async (params: AuthenticatedMWType & {refs: {collection: string; id: string}[]}) =>
    ({refs: await visibleRecordRefs(params, params.refs)})));

const app = appFor([
    {basePath: "/api/things", router: things.router, module: "core"},
    {basePath: "/api/gadgets", router: gadgets.router, module: "core"},
    {basePath: "/api/off", router: offModule.router, module: "chatRecordsTestMissingModule"},
    {basePath: recordsRoute.basePath, router: recordsRoute.router, module: "core"},
    {basePath: "/api/probe", router: probe, module: "core"},
]);

const companyId = new Types.ObjectId().toString();
const otherCompanyId = new Types.ObjectId().toString();
const everything: TestCaller = {
    userId: new Types.ObjectId().toString(),
    companyId,
    permissions: allPermissionTags([things.model, gadgets.model, offModule.model]),
};
const onlyGadgets: TestCaller = {userId: new Types.ObjectId().toString(), companyId, permissions: allPermissionTags([gadgets.model])};

const post = (caller: TestCaller, path: string, body: Record<string, unknown>) =>
    request(app).post(path).set(callerHeader(caller)).send(body);

const ids: Record<string, string> = {};

async function insert(model: mongoose.Model<IThing>, key: string, title: string, company: string, extra: Record<string, unknown> = {}) {
    const result = await model.collection.insertOne({title, company: new Types.ObjectId(company), deletedAt: null, ...extra});
    ids[key] = result.insertedId.toString();
}

beforeAll(async () => {
    await connectTestDatabase();
    await insert(things.model, "alpha", "Alpha", companyId);
    await insert(things.model, "alpine", "Alpine", otherCompanyId);
    await insert(things.model, "alphaHidden", "Alpha secret", companyId, {hidden: true});
    await insert(gadgets.model, "alphaGadget", "Alpha gadget", companyId);
    await insert(offModule.model, "alphaOff", "Alpha off", companyId);
}, 120000);

afterAll(async () => {
    await disconnectTestDatabase();
});

describe("record search (D162)", {timeout: 60000}, () => {
    it("finds matching records of every kind the caller may read, inside their company and each route's own filter", async () => {
        const res = await post(everything, "/api/user/chats/records/search", {q: "alp"});
        expect(res.status).toBe(200);
        const byKind = Object.fromEntries(res.body.groups.map((g: {collection: string; items: {label: string}[]}) => [g.collection, g.items.map((i) => i.label)]));
        expect(byKind[THINGS]).toEqual(["Alpha"]);
        expect(byKind[GADGETS]).toEqual(["Alpha gadget"]);
        expect(byKind[OFF]).toBeUndefined();
    });

    it("leaves out kinds the caller may not read", async () => {
        const res = await post(onlyGadgets, "/api/user/chats/records/search", {q: "alp"});
        expect(res.status).toBe(200);
        expect(res.body.groups.map((g: {collection: string}) => g.collection)).toEqual([GADGETS]);
    });

    it("needs two characters to search every kind", async () => {
        const res = await post(everything, "/api/user/chats/records/search", {q: "a"});
        expect(res.body.groups).toEqual([]);
    });

    it("pages one kind, without a query too", async () => {
        const res = await post(everything, "/api/user/chats/records/search", {collection: THINGS.toUpperCase(), limit: 5});
        expect(res.status).toBe(200);
        expect(res.body.groups).toEqual([{collection: THINGS, total: 1, items: [{id: ids.alpha, label: "Alpha"}]}]);
    });
});

describe("record resolve (D162)", {timeout: 60000}, () => {
    it("labels what the caller may see and says why for the rest", async () => {
        const refs = [
            {collection: THINGS, id: ids.alpha},
            {collection: THINGS, id: ids.alpine},
            {collection: THINGS, id: ids.alphaHidden},
            {collection: OFF, id: ids.alphaOff},
            {collection: "noSuchKind", id: ids.alpha},
        ];
        const res = await post(everything, "/api/user/chats/records/resolve", {refs});
        expect(res.status).toBe(200);
        expect(res.body.records.map((r: {status: string; label?: string}) => [r.status, r.label])).toEqual([
            ["ok", "Alpha"],
            ["unavailable", undefined], // another company's
            ["unavailable", undefined], // hidden by the route's own select filter
            ["noAccess", undefined], // module the company lacks
            ["noAccess", undefined], // no such kind
        ]);
    });

    it("tells a caller without the read permission nothing about the record", async () => {
        const res = await post(onlyGadgets, "/api/user/chats/records/resolve", {refs: [{collection: THINGS, id: ids.alpha}]});
        expect(res.body.records).toEqual([{collection: THINGS, id: ids.alpha, status: "noAccess"}]);
    });

    it("lists only the kinds the caller may share", async () => {
        const res = await post(onlyGadgets, "/api/user/chats/records/types", {});
        expect(res.body.collections).toEqual([GADGETS]);
    });
});

describe("records a message shares (D162)", {timeout: 60000}, () => {
    const token = (collection: string, id: string) => recordToken({collection, id});

    it("keeps the records the writer can see, under each kind's own name", async () => {
        const res = await post(everything, "/api/probe/store", {text: `see ${token(THINGS.toUpperCase(), ids.alpha)} and ${token(GADGETS, ids.alphaGadget)}`});
        expect(res.status).toBe(200);
        expect(res.body.refs).toEqual([{collection: THINGS, id: ids.alpha}, {collection: GADGETS, id: ids.alphaGadget}]);
    });

    it("refuses a record the writer cannot see", async () => {
        const foreign = await post(everything, "/api/probe/store", {text: token(THINGS, ids.alpine)});
        expect(foreign.status).toBe(403);
        expect(foreign.body.error_code).toBe("chat_record_unavailable");
        const unreadable = await post(onlyGadgets, "/api/probe/store", {text: token(THINGS, ids.alpha)});
        expect(unreadable.body.error_code).toBe("chat_record_unavailable");
    });

    it("refuses records in a website visitor chat", async () => {
        const res = await post(everything, "/api/probe/store", {text: token(THINGS, ids.alpha), isPublicChat: true});
        expect(res.body.error_code).toBe("chat_records_not_allowed");
    });

    it("refuses more than ten records", async () => {
        const text = Array.from({length: 11}, () => token(THINGS, new Types.ObjectId().toString())).join(" ");
        const res = await post(everything, "/api/probe/store", {text});
        expect(res.body.error_code).toBe("chat_records_too_many");
    });

    it("shares nothing for a text without records", async () => {
        const res = await post(everything, "/api/probe/store", {text: "plain text"});
        expect(res.body.refs).toEqual([]);
    });

    it("forwards only the original's records the forwarder can see", async () => {
        const res = await post(onlyGadgets, "/api/probe/visible", {
            refs: [{collection: THINGS, id: ids.alpha}, {collection: GADGETS, id: ids.alphaGadget}],
        });
        expect(res.body.refs).toEqual([{collection: GADGETS, id: ids.alphaGadget}]);
    });
});
