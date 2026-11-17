import {afterAll, beforeAll, describe, expect, it, vi} from "vitest";
import {ObjectId} from "mongodb";
import request from "supertest";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";

const {companyId, countryId} = vi.hoisted(() => ({companyId: "6a0000000000000000000001", countryId: "6a0000000000000000000002"}));
// Like the real authMW, the session company comes without its addresses.
vi.mock("@coreModule/utilities/middlewares/authMW", async () => {
    const {getLogger} = await import("@coreModule/loggers/serverLog");
    const {ObjectId: Id} = await import("mongodb");
    return {
        default: () => (req: {body: Record<string, unknown>}, _res: unknown, next: () => void) => {
            req.body.logger = getLogger("validateToken-test");
            req.body.userInfo = {
                _id: new Id(), username: "arta@example.com", name: "Arta", surname: "Hoxha", timezone: "Europe/Tirane",
                getCompanyRolePermissions: async () => [],
            };
            req.body.company = {_id: new Id(companyId), name: "Kudoo Market", timezone: "Europe/Tirane"};
            req.body.companyTimeZone = "Europe/Tirane";
            req.body.actionUserCtx = {modules: ["core"], isAdmin: false, permissions: []};
            next();
        },
    };
});

import {appFor} from "@coreModule/_tests/httpHarness";
import Company from "@coreModule/database/schemas/company/company";
import type {Router} from "express";

let app: ReturnType<typeof appFor>;

beforeAll(async () => {
    // The route file exports with `module.exports`.
    const route = await import("@coreModule/api/user/public/validateToken") as {router?: Router; default?: {router: Router}};
    app = appFor([{basePath: "/api/user/validateToken", router: (route.router ?? route.default?.router)!, module: "core"}]);
    await connectTestDatabase();
    await Company.collection.insertOne({
        _id: new ObjectId(companyId), company: new ObjectId(companyId), name: "Kudoo Market", vat: "KM", deletedAt: null,
        addresses: [{street: "Rruga Myslym Shyri 26", country: new ObjectId(countryId), city: new ObjectId(), latitude: 41.3234, longitude: 19.8182}],
    });
}, 120000);

afterAll(async () => {
    await disconnectTestDatabase();
});

// TD-F114 (and TD-F60): the session company never carried its map location, and a new address could not start in its
// country, because the company it was read from had no addresses loaded.
describe("session company", () => {
    it("carries its map location and its country", async () => {
        const res = await request(app).get("/api/user/validateToken");

        expect(res.status).toBe(200);
        expect(res.body.company).toMatchObject({location: {latitude: 41.3234, longitude: 19.8182}, country: countryId});
    });
});
