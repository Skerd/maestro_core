/**
 * HTTP test harness: mounts real routers on an Express app with the API's
 * error handling, and an auth stub that takes the caller from test headers
 * instead of a JWT. Mock auth in the test file (vi.mock is hoisted per file):
 *
 *   vi.mock("@coreModule/utilities/middlewares/authMW", async () =>
 *       (await import("@coreModule/_tests/httpHarness")).authMWStub);
 */
import http from "node:http";
import {once} from "node:events";
import {beforeAll} from "vitest";
import express, {type Router} from "express";
import type {Model} from "mongoose";
import {ObjectId} from "mongodb";
import {normalizeSchemaPermissions} from "@coreModule/database/utilities";
import {getLogger} from "@coreModule/loggers/serverLog";
import {requestContext} from "@coreModule/utilities/endpoints/requestContext";
import {ServerError} from "armonia/src/modules/core/types";
import {stripServerKeys} from "@coreModule/utilities/middlewares/serverKeys";
import {actionPermissionEntries} from "@coreModule/utilities/security/actionPermissions";

export type TestCaller = {userId: string; companyId: string; isAdmin?: boolean; permissions?: string[]; modules?: string[]};

export const authMWStub = {
    default: (scope?: string) => (req: any, _res: any, next: any) => {
        const caller = callers.get(req.header("x-test-caller") ?? "");
        if (!caller) throw new Error("Unknown test caller: build the header with callerHeader()");
        const actionUserCtx = {
            userId: caller.userId,
            orgId: caller.companyId,
            isAdmin: caller.isAdmin ?? false,
            permissions: caller.permissions ?? [],
            isSelf: true,
            ...(caller.modules ? {modules: caller.modules} : {}),
        };
        req.body.languageCode = "en-US";
        req.body.logger = getLogger(req.originalUrl);
        req.body.company = {_id: new ObjectId(caller.companyId), name: "Test company"};
        req.body.actionUserCtx = actionUserCtx;
        // Like authMW: only a private request names its tenant here; a public one gets it from
        // resolveCompanyByOrigin (or not at all), so tests see production's tenant scoping (D16).
        const tenant = scope === "public" ? {} : {tenantCompanyId: caller.companyId};
        requestContext.run({...requestContext.getStore(), actionUserCtx, ...tenant, languageCode: "en-US"}, () => next());
    },
};

/** Callers by header id: a header carrying every permission tag outgrows Node's 16 KB header limit. */
const callers = new Map<string, TestCaller>();

/** Header that authenticates a request as `caller` under the stub. */
export function callerHeader(caller: TestCaller): Record<string, string> {
    const id = JSON.stringify([caller.userId, caller.companyId, caller.isAdmin ?? false, caller.permissions?.length ?? 0, callers.size]);
    const known = [...callers].find(([, value]) => value === caller);
    if (known) return {"x-test-caller": known[0]};
    callers.set(id, caller);
    return {"x-test-caller": id};
}

/**
 * `module` tags requests with their route module the way routeRegistry does, so module checks and
 * tenant-scope enforcement (D16) see the same context as in production. Call it at a test file's top level
 * (it registers a `beforeAll` that waits for the loopback bind).
 */
export function appFor(routes: {basePath: string; router: Router; module?: string}[]) {
    const app = express();
    // A fresh context per request, as in production (the server starts outside any context): a test
    // that runs as a company (D16) must not hand its tenant to the routes it calls.
    app.use((_req, _res, next) => requestContext.run({}, () => next()));
    app.use(express.json());
    // Mounted like routeRegistry does, so tests see production's body guard.
    for (const {basePath, router, module} of routes) {
        const tag = (_req: unknown, _res: unknown, next: () => void) =>
            module ? requestContext.run({...requestContext.getStore(), routeModule: module}, () => next()) : next();
        app.use(basePath, stripServerKeys, tag, router);
    }
    app.use((error: unknown, _req: any, res: any, _next: any) => {
        if (error instanceof ServerError) return res.status(error.status).json(error);
        return res.status(500).json({error_code: "internal_error", message: (error as Error)?.message});
    });
    // Given an app, supertest wraps it in its own server, listens on every interface and connects to 127.0.0.1;
    // on macOS another process can hold the same port on 127.0.0.1 alone and answer instead (TD-T11, once an
    // HTTP/2 server). A server already listening on loopback is used as is. `unref` lets the worker exit.
    const server = http.createServer(app).listen(0, "127.0.0.1").unref();
    // Node binds a named host asynchronously; a request made before that would make supertest listen again,
    // on every interface. Called at a test file's top level, so the hook runs before its tests.
    beforeAll(async () => {
        if (!server.listening) await once(server, "listening");
    });
    return server;
}

/** Every permission tag of these models, their actions included: what an admin role holds after boot. */
export function allPermissionTags(models: Model<any>[]): string[] {
    const tags = new Set<string>();
    const collect = (value: unknown) => {
        if (typeof value === "string" && value.includes("[")) tags.add(value);
        else if (value && typeof value === "object") Object.values(value).forEach(collect);
    };
    for (const model of models) collect(normalizeSchemaPermissions(model));
    // Its @action permissions too (D14), registered when the test imported the routers.
    const prefixes = models.map((model) => `${model.collection.name}[`);
    for (const {tag} of actionPermissionEntries()) {
        if (prefixes.some((prefix) => tag.startsWith(prefix))) tags.add(tag);
    }
    return [...tags];
}
