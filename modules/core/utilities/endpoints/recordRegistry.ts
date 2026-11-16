import type {Router} from "express";
import type {Model} from "mongoose";
import type {ZodType} from "zod";
import type {SelectResponse} from "armonia/src/modules/core/types/shared.types";
import {ServerError} from "armonia/src/modules/core/types";
import type {AuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import {SERVER_KEYS} from "@coreModule/utilities/middlewares/serverKeys";
import {getModelCollectedData} from "@coreModule/database/collections";
import SchemaGuard from "@coreModule/database/security/schemaGuard";
import {isPlatformOnly, mayUsePlatformOnly} from "@coreModule/database/plugins/platformOnlyPlugin";
import {isModuleEnabledForCompany} from "@coreModule/utilities/modules/companyModules";
import {companyTimeZone} from "@coreModule/utilities/time/companyTimeZone";

/**
 * Every kind of record a chat message can point at (D162), registered by the router that serves it, so it covers every
 * entity without a list to keep: `createCrudRouter` registers each resource it builds, and a hand-written router
 * (company users) registers itself the same way. `routeRegistry` then records the module each router is served under.
 *
 * A chat read of a record runs the resource's **own** select handler, with the same checks its `/select` route runs
 * before it (CORE-04): the company has the module, the platform-only guard, the caller's read permission, then the
 * route's validated form. So a record is listed or labelled in chat exactly when its own select would list or label it.
 */
export type RecordResource = {
    /** Access-model name (`createCrudRouter`'s `collectionName`, e.g. `products`). */
    collection: string;
    model: Model<any>;
    /** The `/select` route's form schema. */
    selectSchema: (languageCode: string, form: unknown) => ZodType;
    /** The `/select` route's handler. */
    runSelect: (params: any) => Promise<SelectResponse>;
};

type MountedRecordResource = RecordResource & {moduleName: string};

/** The body a chat read posts to a resource's select: a search page, or the labels of stored ids. */
export type RecordSelectBody = {name?: string; ids?: string[]; page: number; limit: number};

export type RecordSelectResult = {status: "ok"; response: SelectResponse} | {status: "noAccess"};

const byRouter = new WeakMap<Router, RecordResource>();
const byCollection = new Map<string, MountedRecordResource>();

/** Called by the router that serves `resource`, when it is built. */
export function registerRecordResource(router: Router, resource: RecordResource): void {
    byRouter.set(router, resource);
}

/** Called by `routeRegistry` as it mounts `router` for `moduleName`; a router that registered no resource is ignored. */
export function recordRouterMounted(router: Router, moduleName: string): void {
    const resource = byRouter.get(router);
    if (resource) byCollection.set(resource.collection.toLowerCase(), {...resource, moduleName});
}

/** The mounted resource of `collection` (case-insensitive), if any. */
export function getRecordResource(collection: string): MountedRecordResource | undefined {
    return byCollection.get(collection.toLowerCase());
}

export function mountedRecordResources(): MountedRecordResource[] {
    return [...byCollection.values()];
}

/** Server keys that belong to one route's middleware chain, rebuilt for the resource rather than carried over. */
const ROUTE_KEYS = new Set(["sanitizedReadFields", "sanitizedWriteFields", "dslFilterQuery", "validatedForm", "tableConfig", "session"]);

/** The caller's auth keys only, so a resource's handler never reads a field of the chat request. */
function callerKeysOf(params: AuthenticatedMWType): Record<string, unknown> {
    const source = params as unknown as Record<string, unknown>;
    const keys: Record<string, unknown> = {};
    for (const key of SERVER_KEYS) {
        if (!ROUTE_KEYS.has(key) && key in source) keys[key] = source[key];
    }
    return keys;
}

/** Whether the caller may read records of `resource` at all: module, platform-only guard, read permission. */
export function callerMayRead(resource: MountedRecordResource, params: AuthenticatedMWType): boolean {
    return readFieldsOf(resource, params) !== null;
}

/** The caller's readable fields of `resource`, as its route's sanitizer computes them; `null` when they may read none. */
function readFieldsOf(resource: MountedRecordResource, params: AuthenticatedMWType) {
    const {company, actionUserCtx} = params;
    if (!isModuleEnabledForCompany(company, resource.moduleName)) return null;
    if (isPlatformOnly(resource.model) && !mayUsePlatformOnly(resource.model, company, actionUserCtx.modules)) return null;
    const {readFields} = getModelCollectedData(resource.collection);
    if (!readFields) return null;
    try {
        const sanitized = SchemaGuard.sanitizeFields(resource.model, readFields, "read", params.actionUserCtx, params.languageCode);
        return Object.keys(sanitized).length > 0 ? sanitized : null;
    } catch (error) {
        if (error instanceof ServerError) return null;
        throw error;
    }
}

/**
 * Runs `resource`'s own select for the caller. `noAccess` when the caller may not read it, its form refuses the body, or
 * the handler refuses the caller (a 4xx); any other failure is thrown.
 */
export async function selectRecords(
    resource: MountedRecordResource,
    params: AuthenticatedMWType,
    body: RecordSelectBody,
): Promise<RecordSelectResult> {
    const {company, languageCode} = params;
    const sanitizedReadFields = readFieldsOf(resource, params);
    if (!sanitizedReadFields) return {status: "noAccess"};

    const parsed = resource.selectSchema(languageCode, null).safeParse(body);
    if (!parsed.success) return {status: "noAccess"};
    const form = parsed.data as Record<string, unknown>;

    try {
        const response = await resource.runSelect({
            ...callerKeysOf(params),
            companyTimeZone: params.companyTimeZone ?? companyTimeZone(company),
            ...form,
            validatedForm: form,
            sanitizedReadFields,
        });
        return {status: "ok", response};
    } catch (error) {
        if (error instanceof ServerError && error.status < 500) return {status: "noAccess"};
        throw error;
    }
}
