import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";

const ids = vi.hoisted(() => ({
    platform: "64a000000000000000000001",
    shop: "64a000000000000000000002",
    clinic: "64a000000000000000000003",
}));

// The harness stub, with the caller's company marked as the platform owner when it is the platform, as authMW loads it.
vi.mock("@coreModule/utilities/middlewares/authMW", async () => {
    const {authMWStub} = await import("@coreModule/_tests/httpHarness");
    return {
        default: (scope?: string) => (req: {body: Record<string, any>}, res: unknown, next: () => void) =>
            authMWStub.default(scope)(req, res, () => {
                req.body.company = {...req.body.company, isPlatformOwner: String(req.body.company._id) === ids.platform};
                next();
            }),
    };
});
vi.mock("@coreModule/utilities/middlewares/rateLimiter", () => ({
    rateLimiter: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("@coreModule/domain/notifications/notificationEventBus", async (importOriginal) => ({
    ...await importOriginal<typeof import("@coreModule/domain/notifications/notificationEventBus")>(),
    emitNotificationEvent: vi.fn(),
}));

import mongoose from "mongoose";
import {ObjectId} from "mongodb";
import request from "supertest";
import {allPermissionTags, appFor, callerHeader, type TestCaller} from "@coreModule/_tests/httpHarness";
import {asCrossTenant} from "@coreModule/utilities/endpoints/tenantScope";
import {emitNotificationEvent} from "@coreModule/domain/notifications/notificationEventBus";
import * as countryRoute from "@coreModule/api/auxiliary/private/country";
import {platformListAccess} from "@coreModule/api/platformListRoute";
import Company from "@coreModule/database/schemas/company/company";
import Country from "@coreModule/database/schemas/country/country";

const platform = new ObjectId(ids.platform);
const shop = new ObjectId(ids.shop);
const clinic = new ObjectId(ids.clinic);
const userId = new ObjectId();
const app = appFor([{...countryRoute, basePath: "/api/auxiliary/country"}]);
const permissions = allPermissionTags([Country]);
const caller = (company: ObjectId, tags = permissions): TestCaller =>
    ({userId: userId.toString(), companyId: company.toString(), isAdmin: true, permissions: tags});
const platformAdmin = caller(platform);
const shopAdmin = caller(shop);
const clinicAdmin = caller(clinic);
const call = (who: TestCaller, path: string, body: object = {}, method: "post" | "put" = "post") =>
    request(app)[method](`/api/auxiliary/country${path}`).set(callerHeader(who)).send(body);
const requestKosovo = (who: TestCaller = shopAdmin) => call(who, "", {name: "Kosovo", code: "XK", phoneCode: "+383"}, "put");
const listIds = async (who: TestCaller): Promise<string[]> =>
    ((await call(who, "", {offset: 0, limit: 50})).body.data as {_id: string}[]).map((row) => row._id);
const selectText = async (who: TestCaller): Promise<string> =>
    JSON.stringify((await call(who, "/select", {page: 1, limit: 50})).body);
const notified = () => vi.mocked(emitNotificationEvent).mock.calls.map(([code, event]) => ({code, payload: event.payload}));

beforeAll(async () => {
    await connectTestDatabase();
}, 120000);

afterAll(async () => {
    await disconnectTestDatabase();
});

beforeEach(() => asCrossTenant("test fixtures span companies", async () => {
    vi.mocked(emitNotificationEvent).mockClear();
    for (const collection of await mongoose.connection.db!.collections()) {
        await collection.deleteMany({});
    }
    await Company.collection.insertMany([
        {_id: platform, company: platform, name: "Kudoo", vat: "P-1", isPlatformOwner: true, isActive: true, modules: ["core"], deletedAt: null},
        {_id: shop, company: platform, name: "Kudoo Market", vat: "S-1", isActive: true, modules: ["core"], deletedAt: null},
        {_id: clinic, company: platform, name: "Clinic", vat: "C-1", isActive: true, modules: ["core"], deletedAt: null},
    ]);
}));

describe("a requestable platform list (requestablePlugin, D160)", () => {
    it("takes another company's create as a request, which needs the request permission", async () => {
        const withoutRequest = caller(shop, permissions.filter((tag) => tag !== "countries[action:request]"));
        const refused = await requestKosovo(withoutRequest);
        expect([refused.status, refused.body.error_code]).toEqual([403, "user_permissions_not_sufficient"]);

        const sent = await requestKosovo();
        expect(sent.status).toBe(200);
        expect(sent.body).toMatchObject({name: "Kosovo", requestStatus: "requested", requestedByCompany: ids.shop});
        expect(await Country.collection.findOne({code: "XK"})).toMatchObject({company: platform, requestStatus: "requested", requestedByCompany: shop, requestedBy: userId, requestedAt: expect.any(Date)});
        expect(notified()).toEqual([{code: "ENTRY_REQUESTED", payload: expect.objectContaining({companyId: ids.platform, list: "countries", entryId: sent.body._id, name: "Kosovo"})}]);

        // The platform's own create is a live row.
        const added = await call(platformAdmin, "", {name: "Albania", code: "AL", phoneCode: "+355"}, "put");
        expect([added.status, added.body.requestStatus]).toEqual([200, "approved"]);
    });

    it("shows a requested entry to the requester and the platform only, and offers it in no select", async () => {
        const kosovo = (await requestKosovo()).body._id as string;

        expect(await listIds(shopAdmin)).toContain(kosovo);
        expect(await listIds(platformAdmin)).toContain(kosovo);
        expect(await listIds(clinicAdmin)).not.toContain(kosovo);
        expect((await call(clinicAdmin, "/single", {_id: kosovo})).body.error_code).toBe("country_not_found");
        for (const who of [shopAdmin, platformAdmin, clinicAdmin]) {
            expect(await selectText(who)).not.toContain(kosovo);
        }
    });

    it("refuses a second request for an entry already requested or in the list", async () => {
        await requestKosovo();
        const again = await requestKosovo(clinicAdmin);
        expect([again.status, again.body.error_code]).toEqual([409, "country_already_exists"]);
    });

    it("is approved by the platform only, and is then used by every company", async () => {
        const kosovo = (await requestKosovo()).body._id as string;

        const byShop = await call(shopAdmin, "/approve", {_id: kosovo});
        expect([byShop.status, byShop.body.error_code]).toEqual([403, "platform_company_required"]);

        // The platform corrects the entry with the list's edit form, then approves it.
        const corrected = await request(app).patch("/api/auxiliary/country").set(callerHeader(platformAdmin)).send({_id: kosovo, name: "Kosova", code: "XK", phoneCode: "+383"});
        expect(corrected.status).toBe(200);
        vi.mocked(emitNotificationEvent).mockClear();
        const approved = await call(platformAdmin, "/approve", {_id: kosovo});
        expect(approved.status).toBe(200);
        expect(approved.body).toMatchObject({_id: kosovo, name: "Kosova", requestStatus: "approved", requestedByCompany: ids.shop, decidedAt: expect.any(String)});
        expect(await selectText(clinicAdmin)).toContain(kosovo);
        expect(notified()).toEqual([{code: "ENTRY_REQUEST_APPROVED", payload: expect.objectContaining({companyId: ids.shop, list: "countries", entryId: kosovo, name: "Kosova"})}]);

        // The request record is the requester's and the platform's: another company reads the approved entry alone.
        const fields = ["requestedAt", "requestedByCompanyName", "decidedAt"];
        const asClinic = (await call(clinicAdmin, "/single", {_id: kosovo})).body;
        expect(asClinic.name).toBe("Kosova");
        for (const field of [...fields, "requestedByCompany"]) expect(asClinic).not.toHaveProperty(field);
        const clinicRow = ((await call(clinicAdmin, "", {offset: 0, limit: 50})).body.data as Record<string, unknown>[]).find((row) => row._id === kosovo);
        expect(clinicRow).toBeDefined();
        expect(clinicRow).not.toHaveProperty("requestedByCompanyName");
        const asShop = (await call(shopAdmin, "/single", {_id: kosovo})).body;
        for (const field of fields) expect(asShop).toHaveProperty(field);
        expect((await call(platformAdmin, "/single", {_id: kosovo})).body).toHaveProperty("requestedByCompanyName");

        const twice = await call(platformAdmin, "/approve", {_id: kosovo});
        expect([twice.status, twice.body.error_code]).toEqual([409, "entry_request_not_pending"]);
    });

    it("is rejected with a reason: the entry is deleted, the requester told why, and the code free again", async () => {
        const kosovo = (await requestKosovo()).body._id as string;

        expect((await call(shopAdmin, "/reject", {_id: kosovo, notes: "no"})).body.error_code).toBe("platform_company_required");
        expect((await call(platformAdmin, "/reject", {_id: kosovo})).status).toBe(400);

        vi.mocked(emitNotificationEvent).mockClear();
        const rejected = await call(platformAdmin, "/reject", {_id: kosovo, notes: "Already listed as Serbia's region"});
        expect(rejected.status).toBe(200);
        expect(rejected.body).toMatchObject({requestStatus: "rejected", decisionNotes: "Already listed as Serbia's region", deletedAt: expect.any(String)});
        expect(await Country.collection.findOne({_id: new ObjectId(kosovo)})).toMatchObject({requestStatus: "rejected", decidedBy: userId, deletedAt: expect.any(Date)});
        expect(notified()).toEqual([{code: "ENTRY_REQUEST_REJECTED", payload: expect.objectContaining({companyId: ids.shop, name: "Kosovo", notes: "Already listed as Serbia's region", variant: "withReason"})}]);

        expect((await requestKosovo()).status).toBe(200);
    });

    it("is withdrawn only by the company that requested it, while it waits", async () => {
        const kosovo = (await requestKosovo()).body._id as string;

        const byClinic = await call(clinicAdmin, "/withdraw", {_id: kosovo});
        expect([byClinic.status, byClinic.body.error_code]).toEqual([403, "entry_request_requester_only"]);

        const withdrawn = await call(shopAdmin, "/withdraw", {_id: kosovo});
        expect([withdrawn.status, withdrawn.body.requestStatus]).toEqual([200, "withdrawn"]);
        expect(await Country.collection.findOne({_id: new ObjectId(kosovo)})).toMatchObject({requestStatus: "withdrawn", deletedAt: expect.any(Date)});
        // The requester still sees it, marked withdrawn.
        expect(await listIds(shopAdmin)).toContain(kosovo);
    });

    it("takes the platform's plain delete of a waiting entry as a rejection, and a restore puts it back in the queue", async () => {
        const kosovo = (await requestKosovo()).body._id as string;

        vi.mocked(emitNotificationEvent).mockClear();
        expect((await request(app).delete("/api/auxiliary/country").set(callerHeader(platformAdmin)).send({_id: kosovo})).status).toBe(200);
        expect(await Country.collection.findOne({_id: new ObjectId(kosovo)})).toMatchObject({requestStatus: "rejected", deletedAt: expect.any(Date)});
        expect(notified().map(({code}) => code)).toEqual(["ENTRY_REQUEST_REJECTED"]);

        expect((await request(app).patch("/api/auxiliary/country/restore").set(callerHeader(platformAdmin)).send({_id: kosovo})).status).toBe(200);
        const restored = await Country.collection.findOne({_id: new ObjectId(kosovo)});
        expect(restored).toMatchObject({requestStatus: "requested", deletedAt: null});
        expect(restored?.decidedAt).toBeUndefined();
    });

    it("is reported read-only with the requestable flag in the access map outside the platform company, writable inside", () => {
        const granted = {read: true, write: {name: {}}, create: true, delete: true, restore: true};
        expect(platformListAccess(Country, granted, {isPlatformOwner: true})).toEqual({...granted, requestable: true});
        expect(platformListAccess(Country, granted, {isPlatformOwner: false}))
            .toEqual({read: true, write: false, create: false, delete: false, restore: false, requestable: true});
        expect(platformListAccess(Company, granted, {isPlatformOwner: false})).toEqual(granted);
    });
});
