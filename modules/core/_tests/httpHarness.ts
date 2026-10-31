/**
 * HTTP test harness: mounts real routers on an Express app with the API's
 * error handling, and an auth stub that takes the caller from test headers
 * instead of a JWT. Mock auth in the test file (vi.mock is hoisted per file):
 *
 *   vi.mock("@coreModule/utilities/middlewares/authMW", async () =>
 *       (await import("@coreModule/__tests__/httpHarness")).authMWStub);
 */
import express, {type Router} from "express";
import type {Model} from "mongoose";
import {ObjectId} from "mongodb";
import {normalizeSchemaPermissions} from "@coreModule/database/utilities";
import {getLogger} from "@coreModule/loggers/serverLog";
import {requestContext} from "@coreModule/utilities/endpoints/requestContext";
import {ServerError} from "armonia/src/modules/core/types";

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
        requestContext.run({actionUserCtx}, () => next());
    },
};

/** Header that authenticates a request as `caller` under the stub. */
export function callerHeader(caller: TestCaller): Record<string, string> {
    return {"x-test-caller": JSON.stringify(caller)};
}

export function appFor(routes: {basePath: string; router: Router}[]) {
    const app = express();
    app.use(express.json());
    for (const {basePath, router} of routes) app.use(basePath, router);
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
