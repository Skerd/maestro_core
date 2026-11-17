import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";

vi.mock("@coreModule/utilities/middlewares/authMW", async () => {
    const {authMWStub} = await import("@coreModule/_tests/httpHarness");
    return authMWStub;
});
vi.mock("@coreModule/utilities/middlewares/rateLimiter", () => ({
    rateLimiter: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import mongoose from "mongoose";
import {ObjectId} from "mongodb";
import request from "supertest";
import {allPermissionTags, appFor, callerHeader, type TestCaller} from "@coreModule/_tests/httpHarness";
import {asCrossTenant} from "@coreModule/utilities/endpoints/tenantScope";
import * as userAddressRoute from "@coreModule/api/user/private/userAddress";
import UserAddress from "@coreModule/database/schemas/userAddress/userAddress";

const platform = new ObjectId();
const shop = new ObjectId();
const country = new ObjectId();
const city = new ObjectId();
const app = appFor([{...userAddressRoute, basePath: "/api/user/userAddress"}]);
const permissions = allPermissionTags([UserAddress]);
// Ada signs in at a shop's own site: her session company is the shop, yet her book is the platform's.
const ada: TestCaller = {userId: new ObjectId().toString(), companyId: shop.toString(), permissions, modules: ["core"]};
const marco: TestCaller = {userId: new ObjectId().toString(), companyId: platform.toString(), permissions, modules: ["core"]};
const raw = <T>(fn: () => Promise<T>) => asCrossTenant("test reads the address books", fn);
const home = {type: "shipping", firstName: "Ada", lastName: "Lovelace", street: "Bahnhofstrasse 1", city: city.toString(), country: country.toString(), latitude: 47.37, longitude: 8.54};

beforeAll(async () => {
    await connectTestDatabase();
}, 120000);

afterAll(async () => {
    await disconnectTestDatabase();
});

beforeEach(() => raw(async () => {
    for (const collection of await mongoose.connection.db!.collections()) {
        await collection.deleteMany({});
    }
    await mongoose.connection.db!.collection("companies").insertMany([
        {_id: platform, name: "Platform", vat: "CHE-1", isPlatformOwner: true, isActive: true},
        {_id: shop, name: "Shop", vat: "CHE-2", isPlatformOwner: false, isActive: true},
    ]);
    await mongoose.connection.db!.collection("countries").insertOne({_id: country, company: platform, name: "Switzerland", code: "CH", phoneCode: "+41", requestStatus: "approved", deletedAt: null});
    await mongoose.connection.db!.collection("cities").insertOne({_id: city, company: platform, name: "Zurich", country, deletedAt: null});
}));

describe("a person's address book (D163)", () => {
    it("stores an address in the platform company as the person's, whichever site they use", async () => {
        const created = await request(app).put("/api/user/userAddress").set(callerHeader(ada)).send(home);
        expect(created.body.error_code ?? "ok").toBe("ok");
        const stored = await raw(() => UserAddress.findOne({}).lean().exec());
        expect(stored?.company).toEqual(platform);
        expect(String(stored?.user)).toBe(ada.userId);

        const viaShop = await request(app).post("/api/user/userAddress/my").set(callerHeader(ada)).send({});
        expect(viaShop.body.data.map((a: {firstName: string}) => a.firstName)).toEqual(["Ada"]);
    });

    it("lists, reads, edits and deletes only the person's own addresses", async () => {
        await request(app).put("/api/user/userAddress/my").set(callerHeader(ada)).send(home);
        await request(app).put("/api/user/userAddress/my").set(callerHeader(marco)).send({...home, firstName: "Marco"});
        const marcosId = String((await raw(() => UserAddress.findOne({firstName: "Marco"}).lean().exec()))?._id);

        const listed = await request(app).post("/api/user/userAddress").set(callerHeader(ada)).send({offset: 0, limit: 20});
        expect(listed.body.data.map((a: {firstName: string}) => a.firstName)).toEqual(["Ada"]);
        expect((await request(app).post("/api/user/userAddress/my").set(callerHeader(ada)).send({})).body.data).toHaveLength(1);

        const single = await request(app).post("/api/user/userAddress/single").set(callerHeader(ada)).send({_id: marcosId});
        expect(single.status).not.toBe(200);
        const edited = await request(app).patch("/api/user/userAddress/my").set(callerHeader(ada)).send({...home, _id: marcosId, firstName: "Taken"});
        expect(edited.body.error_code).toBe("user_address_not_found");
        const deleted = await request(app).delete("/api/user/userAddress/my").set(callerHeader(ada)).send({_id: marcosId});
        expect(deleted.body.error_code).toBe("user_address_not_found");
        expect((await raw(() => UserAddress.findOne({_id: new ObjectId(marcosId)}).lean().exec()))?.firstName).toBe("Marco");
    });

    it("keeps one default per type in a person's book, and never touches another person's default", async () => {
        await request(app).put("/api/user/userAddress/my").set(callerHeader(ada)).send({...home, isDefault: true});
        await request(app).put("/api/user/userAddress/my").set(callerHeader(marco)).send({...home, firstName: "Marco", isDefault: true});
        await request(app).put("/api/user/userAddress/my").set(callerHeader(ada)).send({...home, firstName: "Work"});
        const workId = String((await raw(() => UserAddress.findOne({firstName: "Work"}).lean().exec()))?._id);

        const set = await request(app).post("/api/user/userAddress/setDefault").set(callerHeader(ada)).send({_id: workId});
        expect(set.body.error_code ?? "ok").toBe("ok");
        const defaults = await raw(() => UserAddress.find({isDefault: true}).lean().exec());
        expect(defaults.map((a) => a.firstName).sort()).toEqual(["Marco", "Work"]);

        const marcosId = String(defaults.find((a) => a.firstName === "Marco")?._id);
        const foreign = await request(app).post("/api/user/userAddress/setDefault").set(callerHeader(ada)).send({_id: marcosId});
        expect(foreign.status).not.toBe(200);
    });

    it("refuses to save an address while the instance has no platform company", async () => {
        await raw(() => mongoose.connection.db!.collection("companies").deleteMany({isPlatformOwner: true}));
        const created = await request(app).put("/api/user/userAddress/my").set(callerHeader(ada)).send(home);
        expect(created.body.error_code).toBe("user_address_book_unavailable");
        expect((await request(app).post("/api/user/userAddress/my").set(callerHeader(ada)).send({})).body.data).toEqual([]);
    });
});
