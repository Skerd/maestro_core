import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";
import mongoose from "mongoose";
import {ObjectId} from "mongodb";
import request from "supertest";

// The harness stub, plus what the real authMW adds that the route reads (a portal session is in the platform company).
const {caller} = vi.hoisted(() => {
    // Core alone (CORE-01); the panel and portal addresses the response and the new company's sign-in host come from.
    process.env.ENABLED_MODULES = "core";
    process.env.SINFONIA_CLIENT_URLS = "core=http://panel.example.test:5211,portal=http://portal.example.test:5212";
    return {caller: {userId: "", companyId: ""}};
});
vi.mock("@coreModule/utilities/middlewares/authMW", async () => {
    const {authMWStub} = await import("@coreModule/_tests/httpHarness");
    const {ObjectId: Id} = await import("mongodb");
    return {
        default: (scope?: string) => (req: {body: Record<string, unknown>}, res: unknown, next: () => void) => {
            req.body.actionUserInfo = {name: "Ada", surname: "Lovelace", username: "ada@example.com"};
            req.body.userInfo = {_id: new Id(caller.userId)};
            req.body.user = {company: {_id: new Id(caller.companyId)}};
            return authMWStub.default(scope)(req, res, next);
        },
    };
});
vi.mock("@coreModule/utilities/middlewares/rateLimiter", () => ({
    rateLimiter: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import {appFor, callerHeader, type TestCaller} from "@coreModule/_tests/httpHarness";
import Company from "@coreModule/database/schemas/company/company";
import User from "@coreModule/database/schemas/user/user";
import Role from "@coreModule/database/schemas/role/role";
import Country from "@coreModule/database/schemas/country/country";
import City from "@coreModule/database/schemas/city/city";
import {requestContext} from "@coreModule/utilities/endpoints/requestContext";
import {
    clearSelfServeBusinessTypes,
    registerSelfServeBusinessTypes,
    type SelfServeCreatedContext,
} from "@coreModule/domain/company/selfServeBusinessTypes";
import * as businessRoute from "@coreModule/api/portal/private/business";

/* D178: a signed-in person creates their own business from the portal. */

const platformId = new ObjectId();
const personId = new ObjectId();
caller.userId = personId.toString();
caller.companyId = platformId.toString();
const app = appFor([{basePath: businessRoute.basePath, router: businessRoute.router, module: "core"}]);
let person: TestCaller;
let places: {country: ObjectId; city: ObjectId};
const created: {companyId: string; tenant: string | undefined}[] = [];

function businessForm(overrides: Record<string, unknown> = {}) {
    return {
        businessType: "fixtureRental",
        name: "Adriatic Wheels",
        phoneNumber: "+355 69 000 0000",
        address: {street: "Rruga e Durrësit 1", postalCode: "1001", country: places.country.toString(), city: places.city.toString(), latitude: 41.33, longitude: 19.82},
        ...overrides,
    };
}

const createBusiness = (form: Record<string, unknown>) =>
    request(app).put("/api/portal/business").set(callerHeader(person)).field("data", JSON.stringify(form));

beforeAll(async () => {
    await connectTestDatabase();
    await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
    person = {userId: personId.toString(), companyId: platformId.toString(), modules: ["core"]};
    registerSelfServeBusinessTypes("fixtureModule", [{
        key: "fixtureRental",
        modules: [],
        onCreated: async ({company}: SelfServeCreatedContext) => {
            created.push({companyId: String(company._id), tenant: requestContext.getStore()?.tenantCompanyId});
        },
    }]);
}, 120000);

afterAll(async () => {
    clearSelfServeBusinessTypes();
    await disconnectTestDatabase();
});

beforeEach(async () => {
    created.length = 0;
    await Promise.all([Company, User, Role, Country, City].map((model) => model.collection.deleteMany({})));
    await Company.collection.insertOne({
        _id: platformId, company: platformId, name: "Kudoo", vat: "PL-1", allowedDomains: ["*"], isActive: true, isPlatformOwner: true, deletedAt: null,
    });
    await User.collection.insertOne({
        _id: personId, name: "Ada", surname: "Lovelace", fullName: "Ada Lovelace", username: "ada@example.com", email: "ada@example.com",
        password: "$2a$10$abcdefghijklmnopqrstuuJ5x9p5W7v1Yd3yVQm6f6u1C1Tq8b5nG", companies: [platformId], roles: [], isEmailVerified: true,
    });
    const country = await Country.collection.insertOne({company: platformId, name: "Albania", code: "AL", phoneCode: "355", deletedAt: null});
    const city = await City.collection.insertOne({company: platformId, name: "Tirana", country: country.insertedId, deletedAt: null});
    places = {country: country.insertedId, city: city.insertedId};
});

describe("PUT /api/portal/business (D178)", {timeout: 60000}, () => {
    it("creates the person's business under the platform, waiting for approval, with them as its admin", async () => {
        const res = await createBusiness(businessForm());
        expect(res.body.error_code ? res.body : "ok").toBe("ok");

        const business = await Company.collection.findOne({name: "Adriatic Wheels"});
        expect(business).toBeTruthy();
        const id = business!._id as ObjectId;
        expect(business!.parentCompany).toEqual(platformId);
        expect(business!.company).toEqual(platformId);
        expect(business!.portalApproval).toMatchObject({status: "pending"});
        expect(business!.portalApproval.decidedAt).toBeUndefined();
        expect(business!.modules).toEqual(["core"]);
        expect(business!.vat).toBeUndefined();
        // A panel sign-in from the panel's host lands in this company rather than the platform ("*").
        expect(business!.allowedDomains).toEqual(["panel.example.test"]);
        expect(String(business!.addresses[0].city)).toBe(places.city.toString());

        const adminRole = await Role.collection.findOne({company: id, isAdmin: true});
        const account = await User.collection.findOne({_id: personId});
        expect(account!.roles.map((role: {company: ObjectId}) => String(role.company))).toContain(String(id));
        expect(adminRole).toBeTruthy();

        // The module's own setup ran once, inside the new company's tenant.
        expect(created).toEqual([{companyId: String(id), tenant: String(id)}]);
        expect(res.body.data).toEqual({
            companyId: String(id),
            name: "Adriatic Wheels",
            siteSlug: business!.siteSlug,
            siteUrl: `http://${business!.siteSlug}.portal.example.test:5212/`,
            panelUrl: "http://panel.example.test:5211",
        });
    });

    it("records a sign-up without a ref as coming from the portal", async () => {
        const res = await createBusiness(businessForm());
        expect(res.body.error_code ? res.body : "ok").toBe("ok");
        const business = await Company.collection.findOne({name: "Adriatic Wheels"});
        expect(business!.signupSource).toMatchObject({via: "selfServe"});
        expect(business!.signupSource.refCompany).toBeUndefined();
    });

    it("records the company whose site's link brought the person (P23.9)", async () => {
        const referrerId = new ObjectId();
        await Company.collection.insertOne({
            _id: referrerId, company: platformId, name: "Rental Co", siteSlug: "rental-co", allowedDomains: ["none.none.com"], isActive: true, deletedAt: null,
        });
        const res = await createBusiness(businessForm({ref: "Rental-Co"}));
        expect(res.body.error_code ? res.body : "ok").toBe("ok");
        const business = await Company.collection.findOne({name: "Adriatic Wheels"});
        expect(business!.signupSource).toMatchObject({via: "selfServe", refCompany: referrerId});
    });

    it("ignores a ref no active company has, without refusing the sign-up", async () => {
        await Company.collection.insertOne({
            _id: new ObjectId(), company: platformId, name: "Closed Co", siteSlug: "closed-co", allowedDomains: ["none.none.com"], isActive: false, deletedAt: null,
        });
        for (const [name, ref] of [["Unknown Ref", "nobody-here"], ["Inactive Ref", "closed-co"]]) {
            const res = await createBusiness(businessForm({name, ref}));
            expect(res.body.error_code ? res.body : "ok").toBe("ok");
            const business = await Company.collection.findOne({name});
            expect(business!.signupSource).toMatchObject({via: "selfServe"});
            expect(business!.signupSource.refCompany).toBeUndefined();
        }
    });

    it("refuses a business type no module offers", async () => {
        const res = await createBusiness(businessForm({businessType: "spaceTravel"}));
        expect(res.body.error_code).toBe("business_type_not_offered");
        expect(await Company.collection.countDocuments({})).toBe(1);
    });

    it("lets one person create three businesses, not a fourth", async () => {
        for (const name of ["One", "Two", "Three"]) {
            const res = await createBusiness(businessForm({name}));
            expect(res.body.error_code ? res.body : "ok").toBe("ok");
        }
        const fourth = await createBusiness(businessForm({name: "Four"}));
        expect(fourth.body.error_code).toBe("self_serve_business_limit_reached");
        expect(fourth.body.message).toContain("3");
        expect(await Company.collection.countDocuments({portalApproval: {$exists: true}})).toBe(3);
    });

    it("needs where the business is", async () => {
        const res = await createBusiness(businessForm({address: undefined}));
        expect(res.status).toBe(400);
        expect(await Company.collection.countDocuments({})).toBe(1);
    });
});
