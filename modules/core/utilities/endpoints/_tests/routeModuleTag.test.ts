import {describe, expect, it} from "vitest";
import express, {Router} from "express";
import request from "supertest";
import {RouteRegistry} from "@coreModule/utilities/endpoints/routeRegistry";
import {requestContext} from "@coreModule/utilities/endpoints/requestContext";

const echoRouteModule = () => {
    const router = Router();
    router.get("/whoami", (_req, res) => {
        res.json({routeModule: requestContext.getStore()?.routeModule ?? null});
    });
    return router;
};

describe("RouteRegistry route module tag", () => {
    it("tags each request with the module whose router handles it", async () => {
        const app = express();
        const core = new RouteRegistry();
        core.register("/api/company", {router: echoRouteModule()});
        // A broad core mount that does not handle the path falls through to the next one.
        core.register("/api", {router: Router()});
        core.applyRoutes(app, "core");
        const rental = new RouteRegistry();
        rental.register("/api/carRental/vehicle", {router: echoRouteModule()});
        rental.applyRoutes(app, "carRental");

        expect((await request(app).get("/api/company/whoami")).body).toEqual({routeModule: "core"});
        expect((await request(app).get("/api/carRental/vehicle/whoami")).body).toEqual({routeModule: "carRental"});
    });
});
