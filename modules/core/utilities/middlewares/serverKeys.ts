import type {NextFunction, Request, Response} from "express";
import {shouldPreserveRawBody} from "@coreModule/utilities/endpoints/rawBodyRouteRegistry";

/**
 * Body keys that server middlewares write (authMW, transactionHandler, schemaSanitizerMW, dslFilterMW,
 * mediaUploadMW, impersonation, visitorAuthMW, publicChatCustomerMW). The request body is client input,
 * so a client must never be able to supply these (SEC-03, D13).
 *
 * `requestId` is not listed: apiServer writes it before routes mount, overwriting any client value.
 */
export const SERVER_KEYS: ReadonlySet<string> = new Set([
    "actionInitializer",
    "actionUserCtx",
    "actionUserInfo",
    "apiCode",
    "company",
    "companyTimeZone",
    "customer",
    "deviceId",
    "dslFilterQuery",
    "languageCode",
    "logger",
    "origin",
    "parentBypass",
    "requestIp",
    "requestSource",
    "sanitizedReadFields",
    "sanitizedWriteFields",
    "session",
    "singleCompanyId",
    "tableConfig",
    "user",
    "userAgent",
    "userInfo",
    "visitorChannel",
    "visitorCompany",
    "visitorUser",
    "validatedForm",
    "_mediaUploadGridFsIds",
]);

/**
 * What the client sent under a server key, kept out of the body. A few contracts legitimately declare a
 * field with such a name (e.g. a campaign recipient's `languageCode`, an order's `customer`);
 * {@link validateFormZod} validates those against the client's own value.
 */
const quarantined = new WeakMap<Request, Record<string, unknown>>();

export function clientValuesOfServerKeys(req: Request): Record<string, unknown> {
    return quarantined.get(req) ?? {};
}

/**
 * First step of every route: moves client-sent server keys out of the body so that only middlewares
 * can set them. Routes that keep the raw body for signature checks (webhooks) are left untouched.
 */
export function stripServerKeys(req: Request, _res: Response, next: NextFunction): void {
    const body: unknown = req.body;
    // Once per request: routers merged on one path each mount this guard, and a second pass would
    // mistake values an earlier router's middleware wrote for client input.
    if (quarantined.has(req)) return next();
    if (shouldPreserveRawBody(req.originalUrl) || body == null || typeof body !== "object" || Array.isArray(body)) {
        return next();
    }
    const fields = body as Record<string, unknown>;
    const held: Record<string, unknown> = {};
    for (const key of Object.keys(fields)) {
        if (SERVER_KEYS.has(key)) {
            held[key] = fields[key];
            delete fields[key];
        }
    }
    quarantined.set(req, held);
    next();
}
