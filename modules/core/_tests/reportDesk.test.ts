import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";
import mongoose from "mongoose";
import {ObjectId} from "mongodb";
import request from "supertest";

const {platformHex} = vi.hoisted(() => ({platformHex: "65b000000000000000000001"}));

// The harness stub, with the platform company marked as such and the caller's sign-in name, as authMW loads them.
vi.mock("@coreModule/utilities/middlewares/authMW", async () => {
    const {authMWStub} = await import("@coreModule/_tests/httpHarness");
    return {
        default: (scope?: string) => (req: {body: Record<string, any>}, res: unknown, next: () => void) =>
            authMWStub.default(scope)(req, res, () => {
                req.body.company = {...req.body.company, isPlatformOwner: req.body.company._id.toString() === platformHex};
                req.body.userInfo = {username: `${req.body.actionUserCtx.userId}@people.test`};
                next();
            }),
    };
});
vi.mock("@coreModule/utilities/middlewares/rateLimiter", () => ({
    rateLimiter: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import {allPermissionTags, appFor, callerHeader, type TestCaller} from "@coreModule/_tests/httpHarness";
import Company from "@coreModule/database/schemas/company/company";
import User from "@coreModule/database/schemas/user/user";
import UserSession from "@coreModule/database/schemas/userSession/userSession";
import ContentReport from "@coreModule/database/schemas/contentReport/contentReport";
import {router as reportsRouter} from "@coreModule/api/reports/private/reports";
import {router as deskRouter} from "@coreModule/api/reports/private/reportDesk";
import {router as companiesRouter} from "@coreModule/api/platform/private/companies";
import {asCrossTenant} from "@coreModule/utilities/endpoints/tenantScope";
import {requestContext} from "@coreModule/utilities/endpoints/requestContext";
import {clearReportables, registerReportables} from "@coreModule/domain/reports/reportables";
import {notHiddenByPlatform, platformHiddenPlugin} from "@coreModule/database/plugins/platformHiddenPlugin";

/* D191: anyone signed in reports a public thing; the platform decides on its desk, and can undo what it changed. */

const platform = new ObjectId(platformHex);
const shop = new ObjectId();
const protectedCo = new ObjectId();
const author = new ObjectId();
const staff = new ObjectId();
const items = {
    listing: new ObjectId(),
    review: new ObjectId(),
    staffPost: new ObjectId(),
    protectedListing: new ObjectId(),
};
const hidden: {id: string; hidden: boolean; tenant: string | undefined}[] = [];

// A module's public record with platformHiddenPlugin: the desk hides it itself (D191).
const HideableItem = mongoose.model("ReportDeskHideableItem", (() => {
    const schema = new mongoose.Schema({name: String, company: mongoose.Schema.Types.ObjectId});
    platformHiddenPlugin(schema);
    return schema;
})());
const PlainItem = mongoose.model("ReportDeskPlainItem", new mongoose.Schema({name: String}));
const hideable = new ObjectId();

const app = appFor([
    {basePath: "/api/reports/desk", router: deskRouter, module: "core"},
    {basePath: "/api/reports", router: reportsRouter, module: "core"},
    {basePath: "/api/platform/companies", router: companiesRouter, module: "core"},
]);
const reporter = (n: number): TestCaller => ({userId: new ObjectId(`65b0000000000000000001${n.toString().padStart(2, "0")}`).toString(), companyId: shop.toString()});
const deskAdmin: TestCaller = {userId: new ObjectId().toString(), companyId: platform.toString(), isAdmin: true, modules: ["core"], permissions: allPermissionTags([ContentReport])};
const shopAdmin: TestCaller = {userId: new ObjectId().toString(), companyId: shop.toString(), isAdmin: true, modules: ["core"], permissions: allPermissionTags([ContentReport])};

const report = (caller: TestCaller, body: Record<string, unknown>) =>
    request(app).post("/api/reports").set(callerHeader(caller)).send({kind: "test.item", reason: "scam", ...body});
const desk = (action: string, body: Record<string, unknown>, caller: TestCaller = deskAdmin) =>
    request(app).post(`/api/reports/desk/${action}`).set(callerHeader(caller)).send(body);
const reportsOn = (recordId: ObjectId) =>
    asCrossTenant("test reads the platform's reports", () => ContentReport.collection.find({recordId}).sort({_id: 1}).toArray());
const stored = <T extends {collection: {findOne: (q: object) => Promise<unknown>}}>(model: T, id: ObjectId) =>
    asCrossTenant("test reads a row", () => model.collection.findOne({_id: id})) as Promise<Record<string, any> | null>;

/** A reported thing per id: owned by a company, written by someone or not. */
const fixtures: Record<string, {title: string; companyId: ObjectId; authorAccountId?: ObjectId}> = {
    [items.listing.toString()]: {title: "Fake watch", companyId: shop},
    [items.review.toString()]: {title: "Spam review", companyId: shop, authorAccountId: author},
    [items.staffPost.toString()]: {title: "Staff post", companyId: shop, authorAccountId: staff},
    [items.protectedListing.toString()]: {title: "Operator listing", companyId: protectedCo},
};

/** Files one report as `caller` and returns the stored report's id. */
async function fileReport(caller: TestCaller, recordId: ObjectId): Promise<string> {
    const res = await report(caller, {recordId: recordId.toString()});
    expect([res.status, res.body.error_code]).toEqual([200, undefined]);
    const rows = await reportsOn(recordId);
    return rows.at(-1)!._id.toString();
}

beforeAll(async () => {
    await connectTestDatabase();
    await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
    clearReportables();
    registerReportables("test", [{
        kind: "test.item",
        typeLabel: {"en-US": "Test item"},
        snapshot: async ({recordId}) => {
            const item = fixtures[recordId.toString()];
            return item ? {title: item.title, companyId: item.companyId, authorAccountId: item.authorAccountId, hidden: false} : null;
        },
        setHidden: async ({recordId, hidden: hide}) => {
            hidden.push({id: recordId.toString(), hidden: hide, tenant: requestContext.getStore()?.tenantCompanyId});
        },
    }, {
        kind: "test.hideable",
        typeLabel: {"en-US": "Hideable item"},
        model: HideableItem,
        snapshot: async ({recordId}) => recordId.equals(hideable) ? {title: "Hideable", companyId: shop, hidden: false} : null,
    }]);
}, 120000);

afterAll(async () => {
    clearReportables();
    await disconnectTestDatabase();
});

beforeEach(() => asCrossTenant("test fixtures span companies", async () => {
    hidden.length = 0;
    for (const collection of await mongoose.connection.db!.collections()) await collection.deleteMany({});
    await Company.collection.insertMany([
        {_id: platform, company: platform, name: "Platform", isPlatformOwner: true, isProtected: true, isActive: true, modules: ["core"], deletedAt: null},
        {_id: shop, company: platform, name: "Watch Shop", isActive: true, modules: ["core"], deletedAt: null},
        {_id: protectedCo, company: platform, name: "Operator", isProtected: true, isActive: true, modules: ["core"], deletedAt: null},
    ]);
    await User.collection.insertMany([
        {_id: author, username: "author@people.test", isBot: false, roles: [{company: shop, roles: []}], deletedAt: null},
        {_id: staff, username: "staff@people.test", isBot: false, roles: [{company: platform, roles: []}], deletedAt: null},
    ]);
    await HideableItem.collection.insertOne({_id: hideable, name: "Hideable", company: shop});
    await UserSession.collection.insertOne({_id: new ObjectId(), user: author, company: shop, isActive: true, expiresAt: new Date(Date.now() + 86_400_000), deletedAt: null});
}));

describe("reporting a public thing", {timeout: 60000}, () => {
    it("keeps the report in the platform company, with what the thing looked like", async () => {
        const res = await report(reporter(1), {recordId: items.listing.toString(), comment: "  Not a real brand  "});
        expect([res.status, res.body.error_code]).toEqual([200, undefined]);
        const [row] = await reportsOn(items.listing);
        expect(row).toMatchObject({
            company: platform, kind: "test.item", recordCompany: shop, recordCompanyName: "Watch Shop", recordTitle: "Fake watch",
            reason: "scam", comment: "Not a real brand", reporter: new ObjectId(reporter(1).userId), reporterEmail: `${reporter(1).userId}@people.test`, status: "open",
        });
    });

    it("takes one open report per thing and person, and refuses unknown kinds and missing things", async () => {
        await fileReport(reporter(1), items.listing);
        expect((await report(reporter(1), {recordId: items.listing.toString()})).body.error_code).toBe("report_already_sent");
        expect((await report(reporter(1), {recordId: items.listing.toString(), kind: "test.nothing"})).body.error_code).toBe("report_kind_unknown");
        expect((await report(reporter(1), {recordId: new ObjectId().toString()})).body.error_code).toBe("report_record_not_found");
        const authorCaller: TestCaller = {userId: author.toString(), companyId: shop.toString()};
        expect((await report(authorCaller, {recordId: items.review.toString()})).body.error_code).toBe("report_own_record");
    });

    it("keeps the desk to the platform company", async () => {
        await fileReport(reporter(1), items.listing);
        const res = await request(app).post("/api/reports/desk").set(callerHeader(shopAdmin)).send({offset: 0, limit: 10});
        expect(res.body.error_code).toBe("platform_company_required");
        const own = await request(app).post("/api/reports/desk").set(callerHeader(deskAdmin)).send({offset: 0, limit: 10});
        expect([own.status, own.body.total ?? own.body.data?.total]).toEqual([200, 1]);
    });
});

describe("deciding a report", {timeout: 60000}, () => {
    it("hides the thing in its owner's company and closes every open report on it; undo shows it again", async () => {
        const first = await fileReport(reporter(1), items.listing);
        await fileReport(reporter(2), items.listing);

        const res = await desk("decide", {_id: first, decision: "itemHidden", note: "Counterfeit"});
        expect([res.status, res.body.error_code]).toEqual([200, undefined]);
        expect(hidden).toEqual([{id: items.listing.toString(), hidden: true, tenant: shop.toString()}]);
        const closed = await reportsOn(items.listing);
        expect(closed.map((row) => [row.status, row.decision, row.decisionNote])).toEqual([["closed", "itemHidden", "Counterfeit"], ["closed", "itemHidden", "Counterfeit"]]);
        expect((await desk("decide", {_id: first, decision: "dismissed"})).body.error_code).toBe("report_not_open");

        expect((await desk("undo", {_id: first})).body.error_code).toBeUndefined();
        expect(hidden.at(-1)).toEqual({id: items.listing.toString(), hidden: false, tenant: shop.toString()});
        expect((await reportsOn(items.listing)).every((row) => row.undoneAt instanceof Date)).toBe(true);
        expect((await desk("undo", {_id: first})).body.error_code).toBe("report_cannot_undo");
    });

    it("suspends the business and lifts it again, never a protected one", async () => {
        const id = await fileReport(reporter(1), items.listing);
        expect((await desk("decide", {_id: id, decision: "companySuspended", note: "Fraud ring"})).body.error_code).toBeUndefined();
        expect(await stored(Company, shop)).toMatchObject({suspendedReason: "Fraud ring", suspendedBy: new ObjectId(deskAdmin.userId)});
        expect((await stored(Company, shop))!.suspendedAt).toBeInstanceOf(Date);
        await desk("undo", {_id: id});
        expect((await stored(Company, shop))!.suspendedAt).toBeUndefined();

        const operator = await fileReport(reporter(1), items.protectedListing);
        expect((await desk("decide", {_id: operator, decision: "companySuspended"})).body.error_code).toBe("company_is_protected");
        expect((await reportsOn(items.protectedListing))[0].status).toBe("open");
    });

    it("bans the author and ends their sessions; refuses a thing with no author and the platform's own staff", async () => {
        const id = await fileReport(reporter(1), items.review);
        expect((await desk("decide", {_id: id, decision: "accountBanned"})).body.error_code).toBeUndefined();
        expect((await stored(User, author))!.bannedAt).toBeInstanceOf(Date);
        const sessions = await asCrossTenant("test reads sessions", () => UserSession.collection.find({user: author}).toArray());
        expect(sessions.map((row) => row.isActive)).toEqual([false]);
        await desk("undo", {_id: id});
        expect((await stored(User, author))!.bannedAt).toBeUndefined();

        const noAuthor = await fileReport(reporter(1), items.listing);
        expect((await desk("decide", {_id: noAuthor, decision: "accountBanned"})).body.error_code).toBe("report_no_author");
        const staffPost = await fileReport(reporter(1), items.staffPost);
        expect((await desk("decide", {_id: staffPost, decision: "accountBanned"})).body.error_code).toBe("account_ban_not_allowed");
    });
});

describe("the platform's companies page suspends a company", {timeout: 60000}, () => {
    const suspend = (id: ObjectId, body: Record<string, unknown>) =>
        request(app).put(`/api/platform/companies/suspension/${id.toString()}`).set(callerHeader(deskAdmin)).send(body);

    it("suspends with a reason and lifts it, and refuses a protected company", async () => {
        const res = await suspend(shop, {suspended: true, reason: "  Unpaid fines  "});
        expect([res.status, res.body.data?.suspended ?? res.body.suspended]).toEqual([200, true]);
        expect((await stored(Company, shop))!.suspendedReason).toBe("Unpaid fines");
        await suspend(shop, {suspended: false});
        expect((await stored(Company, shop))!.suspendedAt).toBeUndefined();
        expect((await suspend(protectedCo, {suspended: true})).body.error_code).toBe("company_is_protected");
        expect((await suspend(platform, {suspended: true})).body.error_code).toBe("company_is_protected");
    });
});

describe("platformHiddenPlugin", {timeout: 60000}, () => {
    const visible = () => asCrossTenant("test reads the public rows", () => HideableItem.countDocuments({_id: hideable, ...notHiddenByPlatform()}));

    it("lets the desk hide a model's record from public reads and show it again", async () => {
        const res = await report(reporter(1), {kind: "test.hideable", recordId: hideable.toString()});
        expect([res.status, res.body.error_code]).toEqual([200, undefined]);
        const [row] = await reportsOn(hideable);
        expect((await desk("decide", {_id: row._id.toString(), decision: "itemHidden"})).body.error_code).toBeUndefined();
        expect((await stored(HideableItem, hideable))!.hiddenByPlatform).toBe(true);
        expect(await visible()).toBe(0);
        await desk("undo", {_id: row._id.toString()});
        expect((await stored(HideableItem, hideable))!.hiddenByPlatform).toBe(false);
        expect(await visible()).toBe(1);
    });

    it("refuses a reportable whose model does not apply the plugin", () => {
        expect(() => registerReportables("test", [{kind: "test.plain", typeLabel: {}, model: PlainItem, snapshot: async () => null}]))
            .toThrow(/does not apply platformHiddenPlugin/);
    });
});
