import {describe, expect, it, vi} from "vitest";
import {ObjectId} from "mongodb";
import request from "supertest";

vi.mock("@coreModule/utilities/middlewares/authMW", async () => (await import("@coreModule/_tests/httpHarness")).authMWStub);
/** What the route logged, by level: the harness gives each request its own logger. */
const logged = vi.hoisted(() => ({err: [] as string[], debug: [] as string[]}));
vi.mock("@coreModule/loggers/serverLog", async (importOriginal) => {
    const original = await importOriginal<typeof import("@coreModule/loggers/serverLog")>();
    return {
        ...original,
        getLogger: (...args: Parameters<typeof original.getLogger>) => ({
            ...original.getLogger(...args),
            err: (message: string) => { logged.err.push(message); },
            debug: (message: string) => { logged.debug.push(message); },
        }),
    };
});
vi.mock("@coreModule/utilities/middlewares/rateLimiter", () => ({
    rateLimiter: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import {allPermissionTags, appFor, callerHeader, type TestCaller} from "@coreModule/_tests/httpHarness";
import Country from "@coreModule/database/schemas/country/country";
import SmtpServer from "@coreModule/database/schemas/smtpServer/smtpServer";
import {router} from "@coreModule/api/auxiliary/private/viewConfigs";

// No database: the route serves the view configs the models registered when imported (Country's, a core fixture).
const app = appFor([{basePath: "/api/auxiliary/viewConfigs", router, module: "core"}]);
const reader: TestCaller = {userId: new ObjectId().toString(), companyId: new ObjectId().toString(), permissions: allPermissionTags([Country]), modules: ["core"]};

describe("view configs route", () => {
    it("serves every view of a model the caller may read, in one request", async () => {
        const response = await request(app).get("/api/auxiliary/viewConfigs").set(callerHeader(reader));

        expect(response.status).toBe(200);
        expect(Object.keys(response.body.countries).length).toBeGreaterThan(0);
    });

    it("leaves out the models the caller may not read", async () => {
        const response = await request(app).get("/api/auxiliary/viewConfigs").set(callerHeader(reader));
        const admin = await request(app).get("/api/auxiliary/viewConfigs").set(callerHeader({...reader, permissions: allPermissionTags([Country, SmtpServer])}));

        expect(response.body.smtpservers).toBeUndefined();
        expect(admin.body.smtpservers).toBeDefined();
    });

    it("logs a model the caller may not read at debug level, not as an error (TD-B169)", async () => {
        logged.err.length = 0;
        logged.debug.length = 0;
        await request(app).get("/api/auxiliary/viewConfigs").set(callerHeader(reader));

        expect(logged.err).toEqual([]);
        expect(logged.debug).toContain("[viewConfigs] smtpservers not readable by the caller");
    });

    // TD-B155: the one-view route read its path params from the body, so it always answered null; nothing called it
    it("has no one-view route", async () => {
        const viewKey = Object.keys((await request(app).get("/api/auxiliary/viewConfigs").set(callerHeader(reader))).body.countries)[0];
        expect((await request(app).get(`/api/auxiliary/viewConfigs/countries/${viewKey}`).set(callerHeader(reader))).status).toBe(404);
    });
});
