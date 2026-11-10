import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";
import mongoose from "mongoose";
import {ObjectId} from "mongodb";
import request from "supertest";
import sharp from "sharp";

// The harness stub, plus what the real authMW adds that the company routes and the upload read.
const {creator} = vi.hoisted(() => {
    // A core test runs core alone (CORE-01). With every module enabled, the first company created imported each
    // vertical's bootstrap for its default roles inside the request: ~40 s of transforms under load (TD-B125).
    process.env.ENABLED_MODULES = "core";
    return {creator: {userId: "", companyId: ""}};
});
vi.mock("@coreModule/utilities/middlewares/authMW", async () => {
    const {authMWStub} = await import("@coreModule/_tests/httpHarness");
    const {ObjectId: Id} = await import("mongodb");
    return {
        default: (scope?: string) => (req: {body: Record<string, unknown>}, res: unknown, next: () => void) => {
            req.body.actionUserInfo = {name: "Ada", surname: "Lovelace", username: "ada@example.com"};
            req.body.userInfo = {_id: new Id(creator.userId)};
            req.body.user = {company: {_id: new Id(creator.companyId)}};
            return authMWStub.default(scope)(req, res, next);
        },
    };
});
vi.mock("@coreModule/utilities/middlewares/rateLimiter", () => ({
    rateLimiter: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import {allPermissionTags, appFor, callerHeader, type TestCaller} from "@coreModule/_tests/httpHarness";
import Company from "@coreModule/database/schemas/company/company";
import User from "@coreModule/database/schemas/user/user";
import Country from "@coreModule/database/schemas/country/country";
import State from "@coreModule/database/schemas/state/state";
import City from "@coreModule/database/schemas/city/city";
import Media from "@coreModule/database/schemas/media/media";
import * as companyRoute from "@coreModule/api/company/private/company";

/* TD-B115: creating a company from the panel's dialog, with a logo and an address, as `createCompany.tsx` sends it. */

const creatorCompany = new ObjectId();
const creatorId = new ObjectId();
creator.userId = creatorId.toString();
creator.companyId = creatorCompany.toString();
const app = appFor([{basePath: companyRoute.basePath, router: companyRoute.router, module: "core"}]);
let admin: TestCaller;
let places: {country: ObjectId; state: ObjectId; city: ObjectId};

const logoPng = () => sharp({create: {width: 8, height: 8, channels: 3, background: "#336699"}}).png().toBuffer();

/** The dialog's request: multipart, the form as `data`, the logo as `files`. */
async function createCompany(fields: {name: string; vat: string; siteSlug: string; withLogo?: boolean; withAddress?: boolean}) {
    const {withLogo = true, withAddress = true, ...profile} = fields;
    const data = {
        ...profile,
        addresses: withAddress ? [{street: "Bahnhofstrasse 1", postalCode: "8001", latitude: 47.37, longitude: 8.54, ...places}].map((address) => ({
            ...address, country: address.country.toString(), state: address.state.toString(), city: address.city.toString(),
        })) : [],
        allowedDomains: [],
    };
    const call = request(app).put("/api/company").set(callerHeader(admin)).field("data", JSON.stringify(data));
    return withLogo ? call.attach("files", await logoPng(), {filename: "logo.png", contentType: "image/png"}) : call;
}

beforeAll(async () => {
    await connectTestDatabase();
    await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
    admin = {userId: creatorId.toString(), companyId: creatorCompany.toString(), isAdmin: true, permissions: allPermissionTags([Company]), modules: ["core"]};
}, 120000);

afterAll(async () => {
    await disconnectTestDatabase();
});

beforeEach(async () => {
    await Promise.all([Company, User, Country, State, City, Media].map((model) => model.collection.deleteMany({})));
    await Company.collection.insertOne({_id: creatorCompany, company: creatorCompany, name: "Creator", vat: "CR-1", allowedDomains: ["*"], isActive: true, deletedAt: null});
    await User.collection.insertOne({
        _id: creatorId, name: "Ada", surname: "Lovelace", fullName: "Ada Lovelace", username: "ada@example.com", email: "ada@example.com",
        password: "$2a$10$abcdefghijklmnopqrstuuJ5x9p5W7v1Yd3yVQm6f6u1C1Tq8b5nG", companies: [creatorCompany], roles: [], isEmailVerified: true,
    });
    const country = await Country.collection.insertOne({company: creatorCompany, name: "Switzerland", code: "CH", phoneCode: "41", deletedAt: null});
    const state = await State.collection.insertOne({company: creatorCompany, name: "Zurich", code: "ZH", country: country.insertedId, deletedAt: null});
    const city = await City.collection.insertOne({company: creatorCompany, name: "Zurich", country: country.insertedId, state: state.insertedId, deletedAt: null});
    places = {country: country.insertedId, state: state.insertedId, city: city.insertedId};
});

describe("PUT /api/company (TD-B115)", {timeout: 60000}, () => {
    it("creates a company with a logo and an address, both its own rows", async () => {
        const res = await createCompany({name: "Lakeside", vat: "LK-1", siteSlug: "lakeside"});
        expect(res.body.error_code ? res.body : "ok").toBe("ok");

        const created = await Company.collection.findOne({vat: "LK-1"});
        expect(created).toBeTruthy();
        const id = created!._id;
        const [address] = created!.addresses;
        const [country, state, city] = await Promise.all([
            Country.collection.findOne({_id: address.country}),
            State.collection.findOne({_id: address.state}),
            City.collection.findOne({_id: address.city}),
        ]);
        expect([country?.company, state?.company, city?.company]).toEqual([id, id, id]);
        expect([country?.code, state?.name, city?.name]).toEqual(["CH", "Zurich", "Zurich"]);
        expect([String(state?.country), String(city?.country), String(city?.state)]).toEqual([String(country?._id), String(country?._id), String(state?._id)]);
        // The creator's places stay as they were.
        expect(await Country.collection.countDocuments({company: creatorCompany})).toBe(1);

        // One logo file, moved to the new company and public like every company logo.
        const media = await Media.collection.find({}).toArray();
        expect(media).toHaveLength(1);
        expect(media[0]._id).toEqual(created!.logo);
        expect(media[0].company).toEqual(id);
        expect(media[0].isPublic).toBe(true);
    });

    it("reuses the new company's place rows for a second address in the same country", async () => {
        const second = await City.collection.insertOne({company: creatorCompany, name: "Winterthur", country: places.country, state: places.state, deletedAt: null});
        const data = {
            name: "Twin", vat: "TW-1", siteSlug: "twin", allowedDomains: [],
            addresses: [places, {...places, city: second.insertedId}].map((place) => ({
                street: "s", postalCode: "1", latitude: 47.37, longitude: 8.54, country: place.country.toString(), state: place.state.toString(), city: place.city.toString(),
            })),
        };
        const res = await request(app).put("/api/company").set(callerHeader(admin)).field("data", JSON.stringify(data));
        expect(res.body.error_code ? res.body : "ok").toBe("ok");
        const created = await Company.collection.findOne({vat: "TW-1"});
        expect(await Country.collection.countDocuments({company: created!._id})).toBe(1);
        expect(await State.collection.countDocuments({company: created!._id})).toBe(1);
        expect(await City.collection.countDocuments({company: created!._id})).toBe(2);
    });

    it("still refuses another company's place", async () => {
        const foreign = await Country.collection.insertOne({company: new ObjectId(), name: "Elsewhere", code: "XX", phoneCode: "1", deletedAt: null});
        const data = {
            name: "Odd", vat: "OD-1", siteSlug: "odd", allowedDomains: [],
            addresses: [{street: "s", postalCode: "1", latitude: 47.37, longitude: 8.54, country: foreign.insertedId.toString(), city: places.city.toString()}],
        };
        const res = await request(app).put("/api/company").set(callerHeader(admin)).field("data", JSON.stringify(data));
        expect(res.body.error_code).toBe("country_not_found");
        expect(await Company.collection.countDocuments({vat: "OD-1"})).toBe(0);
    });

    it("lets the new company change its logo later with its own upload", async () => {
        const res = await createCompany({name: "Later", vat: "LT-1", siteSlug: "later", withAddress: false});
        expect(res.body.error_code ? res.body : "ok").toBe("ok");
        const created = await Company.collection.findOne({vat: "LT-1"});
        const id = created!._id as ObjectId;

        // Now working in the new company: its upload is its own Media row.
        const inNew = {...admin, companyId: id.toString()};
        creator.companyId = id.toString();
        try {
            const edit = await request(app).patch("/api/company").set(callerHeader(inNew))
                .field("data", JSON.stringify({_id: id.toString(), name: "Later", vat: "LT-1"}))
                .attach("files", await logoPng(), {filename: "logo2.png", contentType: "image/png"});
            expect(edit.body.error_code ? edit.body : "ok").toBe("ok");
        } finally {
            creator.companyId = creatorCompany.toString();
        }
        const updated = await Company.collection.findOne({_id: id});
        expect(String(updated!.logo)).not.toBe(String(created!.logo));
        const logo = await Media.collection.findOne({_id: updated!.logo});
        expect(logo?.company).toEqual(id);
    });
});
