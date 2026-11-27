import {describe, expect, it} from "vitest";
import express, {Router} from "express";
import request from "supertest";
import {RouteRegistry} from "@coreModule/utilities/endpoints/routeRegistry";
import {requestContext} from "@coreModule/utilities/endpoints/requestContext";
import {loopbackServer} from "@coreModule/_tests/httpHarness";
import {isPlatformCollection, platformModules, platformTagPrefixes, registerPlatformRouter} from "@coreModule/utilities/security/platformListRegistry";

const echoRouteModule = () => {
    const router = Router();
    router.get("/whoami", (_req, res) => {
        res.json({routeModule: requestContext.getStore()?.routeModule ?? null});
    });
    return router;
};

describe("RouteRegistry route module tag", () => {
    const app = express();
    const core = new RouteRegistry();
    core.register("/api/company", {router: echoRouteModule()});
    // A broad core mount that does not handle the path falls through to the next one.
    core.register("/api", {router: Router()});
    core.applyRoutes(app, "core");
    const rental = new RouteRegistry();
    rental.register("/api/carRental/vehicle", {router: echoRouteModule()});
    rental.applyRoutes(app, "carRental");
    const server = loopbackServer(app);

    it("tags each request with the module whose router handles it", async () => {
        expect((await request(server).get("/api/company/whoami")).body).toEqual({routeModule: "core"});
        expect((await request(server).get("/api/carRental/vehicle/whoami")).body).toEqual({routeModule: "carRental"});
    });
});

describe("RouteRegistry and a module's platform router (D197)", () => {
    const echoPlatformRoute = () => {
        const router = Router();
        router.get("/flag", (_req, res) => {
            res.json({platformRoute: requestContext.getStore()?.platformRoute ?? null});
        });
        return router;
    };
    const app = express();
    const jobs = echoPlatformRoute();
    // Not a platform list: the module records an ordinary router the platform company works on, with its collections.
    registerPlatformRouter(jobs, "routetagtestjobs", "routetagtestquotes");
    const routes = new RouteRegistry();
    routes.register("/api/routeTagTest/jobs", {router: jobs});
    routes.register("/api/routeTagTest/listings", {router: echoPlatformRoute()});
    routes.applyRoutes(app, "routeTagTest");
    const server = loopbackServer(app);

    it("marks only the registered router's requests, and records its module", async () => {
        expect((await request(server).get("/api/routeTagTest/jobs/flag")).body).toEqual({platformRoute: true});
        expect((await request(server).get("/api/routeTagTest/listings/flag")).body).toEqual({platformRoute: false});
        expect(platformModules()).toContain("routeTagTest");
    });

    it("keeps every collection the router serves for the platform company's access", () => {
        expect(isPlatformCollection("routetagtestjobs")).toBe(true);
        expect(isPlatformCollection("routetagtestquotes")).toBe(true);
        expect(platformTagPrefixes()).toEqual(expect.arrayContaining(["routetagtestjobs[", "routetagtestquotes["]));
    });
});
