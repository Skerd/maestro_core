/**
 * HTTP test harness: mounts real routers on an Express app with the API's
 * error handling, and an auth stub that takes the caller from test headers
 * instead of a JWT. Mock auth in the test file (vi.mock is hoisted per file):
 *
 *   vi.mock("@coreModule/utilities/middlewares/authMW", async () =>
 *       (await import("@coreModule/_tests/httpHarness")).authMWStub);
 */
import express, {type Router} from "express";
import type {Model} from "mongoose";
import {ObjectId} from "mongodb";
import {normalizeSchemaPermissions} from "@coreModule/database/utilities";
import {getLogger} from "@coreModule/loggers/serverLog";
import {requestContext} from "@coreModule/utilities/endpoints/requestContext";
import {ServerError} from "armonia/src/modules/core/types";
import {stripServerKeys} from "@coreModule/utilities/middlewares/serverKeys";

export type TestCaller = {userId: string; companyId: string; isAdmin?: boolean; permissions?: string[]};

export const authMWStub = {
    default: () => (req: any, _res: any, next: any) => {
        const caller: TestCaller = JSON.parse(req.header("x-test-caller"));
        const actionUserCtx = {
            userId: caller.userId,
            orgId: caller.companyId,
            isAdmin: caller.isAdmin ?? false,
            permissions: caller.permissions ?? [],
            isSelf: true,
        };
        req.body.languageCode = "en-US";
        req.body.logger = getLogger(req.originalUrl);
        req.body.company = {_id: new ObjectId(caller.companyId), name: "Test company"};
        req.body.actionUserCtx = actionUserCtx;
        requestContext.run({...requestContext.getStore(), actionUserCtx, tenantCompanyId: caller.companyId, languageCode: "en-US"}, () => next());
    },
};

/** Header that authenticates a request as `caller` under the stub. */
export function callerHeader(caller: TestCaller): Record<string, string> {
    return {"x-test-caller": JSON.stringify(caller)};
}

/**
 * `module` tags requests with their route module the way routeRegistry does, so module checks and
 * tenant-scope enforcement (D16) see the same context as in production.
 */
export function appFor(routes: {basePath: string; router: Router; module?: string}[]) {
    const app = express();
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
    return app;
}

/** Every permission tag of these models: what an admin role holds after boot. */
export function allPermissionTags(models: Model<any>[]): string[] {
    const tags = new Set<string>();
    const collect = (value: unknown) => {
        if (typeof value === "string" && value.includes("[")) tags.add(value);
        else if (value && typeof value === "object") Object.values(value).forEach(collect);
    };
    for (const model of models) collect(normalizeSchemaPermissions(model));
    return [...tags];
}
