import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";
import mongoose, {Schema, type Document} from "mongoose";
import {ObjectId} from "mongodb";
import request from "supertest";

// Core alone (CORE-01). The modules' demo seeders are a fake that records how it ran and can be held or made to fail.
const seed = vi.hoisted(() => {
    process.env.ENABLED_MODULES = "core";
    return {
        calls: [] as {companyId: string; tenant?: string; session: boolean; user: boolean; foreignWrite?: string}[],
        gate: null as Promise<void> | null,
        fail: false,
    };
});
vi.mock("@coreModule/utilities/middlewares/authMW", async () => (await import("@coreModule/_tests/httpHarness")).authMWStub);
vi.mock("@coreModule/utilities/middlewares/rateLimiter", () => ({
    rateLimiter: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("@coreModule/utilities/modules/runModuleCompanyDemoSeeds", async () => {
    const {requestContext} = await import("@coreModule/utilities/endpoints/requestContext");
    const {default: db} = await import("mongoose");
    return {
        runModuleCompanyDemoSeeds: vi.fn(async (_logger: unknown, company: {_id: ObjectId; parentCompany?: unknown}) => {
            const store = requestContext.getStore();
            const call: (typeof seed.calls)[number] = {companyId: String(company._id), tenant: store?.tenantCompanyId, session: !!store?.session, user: !!store?.actionUserCtx};
            seed.calls.push(call);
            if (seed.gate) await seed.gate;
            if (seed.fail) throw new Error("a seeder broke");
            const Fixture = db.model("SandboxFixture");
            await Fixture.create({title: "Demo booking", company: company._id});
            // A seeder that reaches for another company is refused by the tenant scope (D16).
            await Fixture.create({title: "Stray", company: company.parentCompany}).catch((error: {error_code?: string}) => {
                call.foreignWrite = error.error_code;
            });
        }),
    };
});

import {appFor, callerHeader, type TestCaller} from "@coreModule/_tests/httpHarness";
import ownershipPlugin from "@coreModule/database/plugins/ownershipPlugin";
import softDeletePlugin from "@coreModule/database/plugins/softDeletePlugin";
import Company from "@coreModule/database/schemas/company/company";
import User from "@coreModule/database/schemas/user/user";
import Role from "@coreModule/database/schemas/role/role";
import Media from "@coreModule/database/schemas/media/media";
import Channel from "@coreModule/database/schemas/channel/channel";
import LastChannelReadMessage from "@coreModule/database/schemas/lastChannelReadMessage/lastChannelReadMessage";
import {companyService} from "@coreModule/database/schemas/company/company.service";
import {createGridFSStorage} from "@coreModule/utilities/gridfs/gridfsStorage";
import {getLogger} from "@coreModule/loggers/serverLog";
import {runInTransaction} from "@coreModule/utilities/middlewares/runInTransaction";
import {findPortalSiteCompany, isPortalListable, portalCompanyClause} from "@coreModule/utilities/marketing/portalCompanies";
import {deleteSandboxCompany} from "@coreModule/domain/company/sandboxCompany";
import * as sandboxRoute from "@coreModule/api/company/private/sandbox";

/* D178, P23.4: "Try with sample data" — a separate sample company, seeded in the background, never listed, deleted in one click. */

interface IFixture extends Document {
    title: string;
    company: ObjectId;
}
// A tenant model of no module (CORE-01): stands in for every module's records.
const fixtureSchema = new Schema<IFixture>({title: String});
ownershipPlugin(fixtureSchema);
softDeletePlugin(fixtureSchema);
const Fixture = mongoose.model<IFixture>("SandboxFixture", fixtureSchema);

const parentId = new ObjectId();
const otherId = new ObjectId();
const adminId = new ObjectId();
const staffId = new ObjectId();
const app = appFor([{basePath: sandboxRoute.basePath, router: sandboxRoute.router, module: "core"}]);
const logger = getLogger("company_sandbox_test");
const admin: TestCaller = {userId: adminId.toString(), companyId: parentId.toString(), isAdmin: true, modules: ["core"]};
const staff: TestCaller = {userId: staffId.toString(), companyId: parentId.toString(), isAdmin: false, modules: ["core"]};
const outsider: TestCaller = {userId: staffId.toString(), companyId: otherId.toString(), isAdmin: true, modules: ["core"]};

const put = (caller: TestCaller, name = "Blloku Dental (sample)") => request(app).put("/api/company/sandbox").set(callerHeader(caller)).send({name});
const get = (caller: TestCaller) => request(app).get("/api/company/sandbox").set(callerHeader(caller));
const del = (caller: TestCaller, id: ObjectId) => request(app).delete("/api/company/sandbox").set(callerHeader(caller)).send({_id: id.toString()});

async function seedStatus(id: ObjectId, status: string) {
    for (let attempt = 0; attempt < 200; attempt++) {
        const company = await Company.collection.findOne({_id: id});
        if (company?.sandboxSeed?.status === status) return company;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Sample company never became ${status}`);
}

/** Every document in the database that names `companyId` as its company, by collection (companies are checked apart). */
async function rowsOf(companyId: ObjectId): Promise<Record<string, number>> {
    const db = mongoose.connection.db!;
    const found: Record<string, number> = {};
    for (const {name} of await db.listCollections({}, {nameOnly: true}).toArray()) {
        if (name === Company.collection.name) continue;
        const count = await db.collection(name).countDocuments({$or: [{company: companyId}, {"metadata.company": companyId.toString()}]});
        if (count > 0) found[name] = count;
    }
    return found;
}

/** A membership as the User schema stores it. */
const membership = (company: ObjectId) => ({_id: new ObjectId(), company, roles: [], rolesCount: 0, active: "active", unsuccessfulLogins: 0, lockedOutUntil: null, lastLogin: null});

const caller = (id: ObjectId, over: Partial<TestCaller> = {}): TestCaller => ({userId: adminId.toString(), companyId: id.toString(), isAdmin: true, modules: ["core"], ...over});

async function insertSandbox(id: ObjectId, seedState: {status: string; startedAt: Date} = {status: "ready", startedAt: new Date()}) {
    await Company.collection.insertOne({
        _id: id, company: parentId, parentCompany: parentId, name: "Blloku Dental (sample)", siteSlug: `sample-${id.toHexString()}`,
        modules: ["core"], allowedDomains: ["none.none.com"], isActive: true, isSandbox: true, sandboxSeed: seedState, deletedAt: null,
    });
}

beforeAll(async () => {
    await connectTestDatabase();
}, 120000);

afterAll(async () => {
    await disconnectTestDatabase();
});

beforeEach(async () => {
    seed.calls.length = 0;
    seed.gate = null;
    seed.fail = false;
    const db = mongoose.connection.db!;
    await Promise.all([...mongoose.modelNames().map((name) => mongoose.model(name).collection.deleteMany({})), db.collection("media.files").deleteMany({}), db.collection("media.chunks").deleteMany({}), db.collection("sandboxunloadedrows").deleteMany({})]);
    await Company.collection.insertMany([
        {_id: parentId, company: parentId, name: "Blloku Dental", siteSlug: "blloku-dental", timezone: "Europe/Tirane", modules: ["core"], allowedDomains: ["*"], isActive: true, deletedAt: null},
        {_id: otherId, company: otherId, name: "Adriatic Drive", siteSlug: "adriatic-drive", modules: ["core"], allowedDomains: ["none.none.com"], isActive: true, deletedAt: null},
    ]);
    const person = {password: "$2a$10$abcdefghijklmnopqrstuuJ5x9p5W7v1Yd3yVQm6f6u1C1Tq8b5nG", isEmailVerified: true};
    await User.collection.insertMany([
        {_id: adminId, ...person, name: "Ada", surname: "Lovelace", fullName: "Ada Lovelace", username: "ada@example.com", companies: [parentId], roles: [membership(parentId)]},
        {_id: staffId, ...person, name: "Bo", surname: "Staff", fullName: "Bo Staff", username: "bo@example.com", companies: [parentId, otherId], roles: [membership(parentId), membership(otherId)]},
    ]);
});

describe("PUT /api/company/sandbox: making the sample company", {timeout: 60000}, () => {
    it("makes a sample company of the caller's company, with its modules and no panel host, the caller as admin, and seeds it after the request", async () => {
        let release = () => {};
        seed.gate = new Promise<void>((resolve) => { release = resolve; });

        const res = await put(admin);
        expect(res.body.error_code ? res.body : "ok").toBe("ok");
        expect(res.body.sandbox).toMatchObject({name: "Blloku Dental (sample)", status: "preparing"});
        const id = new ObjectId(res.body.sandbox._id);

        const sandbox = await Company.collection.findOne({_id: id});
        expect(sandbox).toMatchObject({isSandbox: true, parentCompany: parentId, company: parentId, createdBy: adminId, timezone: "Europe/Tirane", siteSlug: "blloku-dental-sample"});
        expect(sandbox!.modules).toEqual(["core"]);
        // A sign-in never lands in a sample company (TD-B255): it lists no panel host, nor "*".
        expect(sandbox!.allowedDomains).toEqual(["none.none.com"]);
        const adminRole = await Role.collection.findOne({company: id, isAdmin: true});
        const account = await User.collection.findOne({_id: adminId});
        expect(account!.roles.find((role: {company: ObjectId}) => role.company.equals(id))?.roles.map(String)).toEqual([String(adminRole!._id)]);

        // The request answered while the seed was still running: it runs outside it.
        expect(seed.calls).toHaveLength(1);
        expect((await Company.collection.findOne({_id: id}))!.sandboxSeed.status).toBe("preparing");
        expect((await get(admin)).body.sandbox).toMatchObject({_id: String(id), status: "preparing"});

        release();
        const ready = await seedStatus(id, "ready");
        expect(ready.sandboxSeed.finishedAt).toBeInstanceOf(Date);
        // In the sample company's tenant, with no request session or user; another company's rows were out of reach.
        expect(seed.calls[0]).toEqual({companyId: String(id), tenant: String(id), session: false, user: false, foreignWrite: "tenant_scope_violation"});
        expect(await Fixture.collection.countDocuments({company: id})).toBe(1);
        expect(await Fixture.collection.countDocuments({company: parentId})).toBe(0);
        expect((await get(admin)).body.sandbox).toMatchObject({_id: String(id), status: "ready"});

        // Everything its creation and seed wrote (roles, bot, chats, jobs, audit, demo rows) goes in one click.
        expect(Object.keys(await rowsOf(id)).length).toBeGreaterThan(1);
        const deleted = await del(admin, id);
        expect(deleted.body.error_code ? deleted.body : "ok").toBe("ok");
        expect(await rowsOf(id)).toEqual({});
        expect(await Company.collection.countDocuments({_id: id})).toBe(0);
        expect(await User.collection.countDocuments({$or: [{companies: id}, {"roles.company": id}]})).toBe(0);
        // Its bot went with it; the caller's account stayed.
        expect(await User.collection.countDocuments({isBot: true})).toBe(0);
        expect(await User.collection.countDocuments({_id: adminId})).toBe(1);
        expect((await get(admin)).body).toEqual({});

        // A new sample company of the same name can be made again (its bot's name is free).
        const again = await put(admin);
        expect(again.body.error_code ? again.body : "ok").toBe("ok");
        await seedStatus(new ObjectId(again.body.sandbox._id), "ready");
    });

    it("records a seed that failed, so the panel can offer to delete it", async () => {
        seed.fail = true;
        const res = await put(admin);
        expect(res.body.error_code ? res.body : "ok").toBe("ok");
        await seedStatus(new ObjectId(res.body.sandbox._id), "failed");
    });

    it("allows one sample company per company, none inside a sample company, and only for admins", async () => {
        const first = await put(admin);
        expect(first.body.error_code ? first.body : "ok").toBe("ok");
        await seedStatus(new ObjectId(first.body.sandbox._id), "ready");

        expect((await put(admin)).body.error_code).toBe("company_sandbox_exists");
        expect((await put(caller(new ObjectId(first.body.sandbox._id)))).body.error_code).toBe("company_sandbox_of_sandbox");
        expect((await put(staff)).body.error_code).toBe("user_permissions_not_sufficient");
        expect((await put(admin, "   ")).status).toBe(400);
        expect(await Company.collection.countDocuments({isSandbox: true})).toBe(1);
    });
});

describe("GET /api/company/sandbox", () => {
    it("tells the company's admins about its sample company, and an admin inside it which company it belongs to", async () => {
        expect((await get(admin)).body).toEqual({});
        const sandboxId = new ObjectId();
        await insertSandbox(sandboxId, {status: "preparing", startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000)});

        // A seed that never finished (its server stopped) reads as failed.
        expect((await get(admin)).body.sandbox).toMatchObject({_id: String(sandboxId), status: "failed"});
        // A long seed that still beats is still preparing.
        await Company.collection.updateOne({_id: sandboxId}, {$set: {"sandboxSeed.heartbeatAt": new Date()}});
        expect((await get(admin)).body.sandbox).toMatchObject({status: "preparing"});
        expect((await get(caller(sandboxId))).body).toMatchObject({parent: {_id: String(parentId), name: "Blloku Dental"}, sandbox: {_id: String(sandboxId)}});
        expect((await get(staff)).body.error_code).toBe("user_permissions_not_sufficient");
    });
});

describe("a sample company is never listed on the portal", () => {
    it("is left out of every portal listing and its own site does not resolve", async () => {
        const sandboxId = new ObjectId();
        await insertSandbox(sandboxId);
        const listed = (await companyService.findIds(portalCompanyClause("core"))).map(String);
        expect(listed).toContain(String(parentId));
        expect(listed).not.toContain(String(sandboxId));
        const sandbox = await Company.findById(sandboxId);
        expect(isPortalListable(sandbox!, "core")).toBe(false);
        await expect(findPortalSiteCompany(`sample-${sandboxId.toHexString()}`, "core", "en-US")).rejects.toMatchObject({error_code: "portal_company_not_listed"});
        await expect(findPortalSiteCompany("blloku-dental", "core", "en-US")).resolves.toMatchObject({name: "Blloku Dental"});
    });
});

describe("DELETE /api/company/sandbox: deleting the sample company in one click", {timeout: 60000}, () => {
    async function fillSandbox(sandboxId: ObjectId) {
        const gridfs = createGridFSStorage("en-US", "media", logger);
        const ownFile = await gridfs.uploadFile(Buffer.from("own"), "own.jpg");
        const strayFile = await gridfs.uploadFile(Buffer.from("stray"), "stray.jpg", {company: sandboxId.toString()});
        const sharedFile = await gridfs.uploadFile(Buffer.from("shared"), "shared.jpg");
        const parentFile = await gridfs.uploadFile(Buffer.from("parent"), "parent.jpg");
        await Fixture.collection.insertMany([
            {company: sandboxId, title: "Demo booking", deletedAt: null},
            {company: sandboxId, title: "Deleted demo booking", deletedAt: new Date()},
            {company: parentId, title: "Real booking", deletedAt: null},
            {company: otherId, title: "Other booking", deletedAt: null},
        ]);
        await Media.collection.insertMany([
            {company: sandboxId, fileId: ownFile, deletedAt: null},
            {company: sandboxId, fileId: sharedFile, deletedAt: null},
            {company: otherId, fileId: sharedFile, deletedAt: null},
            {company: parentId, fileId: parentFile, deletedAt: null},
        ]);
        await Role.collection.insertMany([
            {company: sandboxId, name: "Admin", slug: "sample-admin", isAdmin: true, permissions: [], deletedAt: null},
            {company: parentId, name: "Admin", slug: "real-admin", isAdmin: true, permissions: [], deletedAt: null},
        ]);
        const [sandboxChannel, parentChannel] = [new ObjectId(), new ObjectId()];
        await Channel.collection.insertMany([
            {_id: sandboxChannel, company: sandboxId, name: "Demo chat", users: [adminId], deletedAt: null},
            {_id: parentChannel, company: parentId, name: "Team", users: [adminId], deletedAt: null},
        ]);
        await LastChannelReadMessage.collection.insertMany([
            {user: adminId, channel: sandboxChannel, time: new Date()},
            {user: adminId, channel: parentChannel, time: new Date()},
        ]);
        // A collection whose model this server has not loaded yet (some load on first use, like the health data keys).
        await mongoose.connection.db!.collection("sandboxunloadedrows").insertMany([
            {company: sandboxId, note: "Sample row of a model not loaded yet"},
            {company: parentId, note: "Real row of a model not loaded yet"},
        ]);
        const demoPerson = new ObjectId();
        await User.collection.updateOne({_id: adminId}, {$push: {companies: sandboxId, roles: membership(sandboxId)}} as never);
        await User.collection.updateOne({_id: staffId}, {$set: {"requests.invitation": {company: sandboxId, opened: false}}});
        await User.collection.insertOne({
            _id: demoPerson, username: "arta.hoxha@example.com", name: "Arta", surname: "Hoxha", companies: [sandboxId],
            roles: [membership(sandboxId)],
        });
        return {ownFile, strayFile, sharedFile, parentFile, demoPerson};
    }

    it("deletes every row, file and membership of the sample company, and nothing of any other company", async () => {
        const sandboxId = new ObjectId();
        await insertSandbox(sandboxId);
        const {ownFile, strayFile, sharedFile, parentFile, demoPerson} = await fillSandbox(sandboxId);
        const parentRowsBefore = await rowsOf(parentId);
        const otherRowsBefore = await rowsOf(otherId);

        const res = await del(admin, sandboxId);
        expect(res.body.error_code ? res.body : "ok").toBe("ok");

        expect(await Company.collection.findOne({_id: sandboxId})).toBeNull();
        expect(await rowsOf(sandboxId)).toEqual({});
        expect(await rowsOf(parentId)).toEqual(parentRowsBefore);
        expect(await rowsOf(otherId)).toEqual(otherRowsBefore);
        expect(await LastChannelReadMessage.collection.countDocuments({})).toBe(1);
        expect(await mongoose.connection.db!.collection("sandboxunloadedrows").countDocuments({company: parentId})).toBe(1);

        const files = (await mongoose.connection.db!.collection("media.files").find({}).toArray()).map((file) => String(file._id));
        expect(files).not.toContain(String(ownFile));
        expect(files).not.toContain(String(strayFile));
        // Still used by another company's media.
        expect(files).toEqual(expect.arrayContaining([String(sharedFile), String(parentFile)]));

        // Accounts stay (users are never deleted, D12); only the sample company's memberships and invitation go.
        const [account, demo, invited] = await Promise.all([adminId, demoPerson, staffId].map((_id) => User.collection.findOne({_id})));
        expect(account!.companies.map(String)).toEqual([String(parentId)]);
        expect(account!.roles.map((role: {company: ObjectId}) => String(role.company))).toEqual([String(parentId)]);
        expect(demo).toMatchObject({companies: [], roles: []});
        expect(invited!.requests?.invitation).toBeUndefined();
        expect(invited!.companies.map(String)).toEqual([String(parentId), String(otherId)]);
    });

    it("lets an admin inside the sample company delete it too", async () => {
        const sandboxId = new ObjectId();
        await insertSandbox(sandboxId);
        const res = await del(caller(sandboxId), sandboxId);
        expect(res.body.error_code ? res.body : "ok").toBe("ok");
        expect(await Company.collection.countDocuments({_id: sandboxId})).toBe(0);
    });

    it("never deletes a company that is not a sample company", async () => {
        const before = await rowsOf(parentId);
        await Fixture.collection.insertOne({company: parentId, title: "Real booking", deletedAt: null});
        const expected = {...before, [Fixture.collection.name]: 1};

        expect((await del(admin, parentId)).body.error_code).toBe("company_not_sandbox");
        expect((await del(admin, new ObjectId())).body.error_code).toBe("company_not_sandbox");
        // The function itself refuses it, whoever calls it.
        await expect(runInTransaction(logger, (session) => deleteSandboxCompany(parentId, {session, logger, languageCode: "en-US"})))
            .rejects.toMatchObject({error_code: "company_not_sandbox"});
        await expect(runInTransaction(logger, (session) => deleteSandboxCompany(otherId, {session, logger, languageCode: "en-US"})))
            .rejects.toMatchObject({error_code: "company_not_sandbox"});
        expect(await rowsOf(parentId)).toEqual(expected);
        expect(await Company.collection.countDocuments({_id: {$in: [parentId, otherId]}})).toBe(2);
    });

    it("refuses a non-admin, an admin of another company, a seed still running, and a sample company with companies under it", async () => {
        const sandboxId = new ObjectId();
        await insertSandbox(sandboxId, {status: "preparing", startedAt: new Date()});
        await Fixture.collection.insertOne({company: sandboxId, title: "Demo booking", deletedAt: null});

        expect((await del(staff, sandboxId)).body.error_code).toBe("user_permissions_not_sufficient");
        expect((await del(outsider, sandboxId)).body.error_code).toBe("user_permissions_not_sufficient");
        expect((await del(admin, sandboxId)).body.error_code).toBe("company_sandbox_preparing");

        // Its server stopped mid-seed: after a while it may be deleted.
        await Company.collection.updateOne({_id: sandboxId}, {$set: {"sandboxSeed.startedAt": new Date(Date.now() - 2 * 60 * 60 * 1000)}});
        const childId = new ObjectId();
        await Company.collection.insertOne({_id: childId, company: sandboxId, parentCompany: sandboxId, name: "Under the sample", allowedDomains: [], isActive: true, deletedAt: null});
        expect((await del(admin, sandboxId)).body.error_code).toBe("company_sandbox_has_companies");
        expect(await Fixture.collection.countDocuments({company: sandboxId})).toBe(1);

        await Company.collection.deleteOne({_id: childId});
        expect((await del(admin, sandboxId)).body.error_code ? "refused" : "ok").toBe("ok");
        expect(await rowsOf(sandboxId)).toEqual({});
    });
});
