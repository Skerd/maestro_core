import {Aggregate, Document, MongooseQueryMiddleware, PipelineStage, Query, Schema, SchemaTypes, Types} from "mongoose";
import {apiValidationException, DEFAULT_EXCEPTION_LANGUAGE} from "armonia/src/modules/core/helpers/exceptions";
import {getLogger} from "@coreModule/loggers/serverLog";
import {requestContext} from "@coreModule/utilities/endpoints/requestContext";
import {checkRequestableReferences, checkTenantReferences, markTenantOwned} from "@coreModule/database/plugins/tenantReferences";
import {preBulkWrite} from "@coreModule/database/plugins/bulkWriteHooks";

export interface OwnershipPluginOptions {
    /**
     * Whether `company` names the tenant that owns the record (default). `false` where it names
     * something else, like a company's parent company, so tenant scoping (D16) leaves the model alone.
     */
    tenantScoped?: boolean;
    /**
     * Field listing the companies the owner shared a record with (e.g. Media `sharedWithCompanies`).
     * Reads and updates then match records the tenant owns OR was shared; creating stays owner-only.
     */
    sharedWith?: string;
}

/**
 * Tenant ownership (DB-01, DB-02): adds `createdBy` and a required `company`, and, unless `tenantScoped: false`, scopes
 * every query, aggregation and write to the request's tenant (D16) and refuses a create or update that stores a reference
 * to another company's row (D104, `tenantReferences.ts`). Its `{company: 1, _id: 1}` index is added by
 * lifeCyclePlugin, which every schema applies.
 */
export const ownershipPlugin = (schema: Schema, options: OwnershipPluginOptions = {}): void => {
    schema.add({
        createdBy: {
            type: SchemaTypes.ObjectId,
            ref: "User",
            required: false,
            index: true,
            refAllowlist: {
                keys: {
                    name: {},
                    surname: {},
                    photo: {}
                }
            },
            permissions: {
                self: {
                    write: "no-permission"
                },
                others: {
                    write: "no-permission"
                }
            },
            dynamicTableConfiguration: {
                visible: true,
                refDisplayKey: ["name", "surname"],
                avatarPath: "photo"
            }
        },
        company: {
            type: Schema.Types.ObjectId,
            ref: "Company",
            required: true,
            permissions: {
                self: {
                    read: "no-permission",
                    write: "no-permission"
                },
                others: {
                    read: "no-permission",
                    write: "no-permission"
                }
            }
        }
    });

    if (options.tenantScoped !== false) {
        applyTenantScope(schema, options.sharedWith);
        markTenantOwned(schema, options.sharedWith);
        checkTenantReferences(schema);
    } else {
        checkRequestableReferences(schema);
    }
};

/* ---------------------------------------------------------------------------------------------
 * Tenant scoping (D16, DB-02): queries, aggregations and writes on tenant models stay inside the
 * current company (`requestContext.tenantCompanyId`). See `tenantScope.ts` for setting it or opting out.
 * ------------------------------------------------------------------------------------------- */

/** Every query that takes a filter. `estimatedDocumentCount` has none; `remove` is document middleware. */
const SCOPED_QUERIES: MongooseQueryMiddleware[] = [
    "count", "countDocuments", "deleteMany", "deleteOne", "distinct", "find", "findOne", "findOneAndDelete",
    "findOneAndRemove", "findOneAndReplace", "findOneAndUpdate", "replaceOne", "update", "updateMany", "updateOne",
];

/** Stages MongoDB requires first in a pipeline; a plugin's own `$match` goes right after them. */
const FIRST_ONLY_STAGES = ["$geoNear", "$search", "$searchMeta", "$collStats", "$indexStats", "$listSessions", "$changeStream"];

/** Where a plugin's filter goes in `pipeline`: first, or right after a stage MongoDB requires first (D15, D16). */
export function pipelineFilterIndex(pipeline: PipelineStage[]): number {
    const lead = pipeline[0];
    return lead && FIRST_ONLY_STAGES.some((stage) => stage in lead) ? 1 : 0;
}

const logger = getLogger("tenantScope");

type Verdict = "tenant" | "absent" | "other";
type Finding = "no-tenant" | "other-company";

interface Scope {
    tenant?: string;
    module?: string;
    languageCode: string;
}

/** The current scope, or null inside `asCrossTenant`. */
function currentScope(): Scope | null {
    const store = requestContext.getStore();
    if (store?.crossTenantReason) return null;
    return {
        tenant: store?.tenantCompanyId,
        module: store?.routeModule,
        languageCode: store?.languageCode ?? DEFAULT_EXCEPTION_LANGUAGE,
    };
}

function hasHexId(value: object): value is {toHexString(): string} {
    return "toHexString" in value && typeof value.toHexString === "function";
}

/** How a `company` filter or value relates to the tenant. Only plain equality and an `$in` of the tenant count as the tenant. */
function companyVerdict(value: unknown, tenant: string): Verdict {
    // `company: null` and an empty `$in` match no tenant's records; narrowed to the tenant they still match nothing.
    if (value === undefined || value === null) return "absent";
    if (typeof value === "string") return value === tenant ? "tenant" : "other";
    if (typeof value !== "object") return "other";
    if (hasHexId(value)) return value.toHexString() === tenant ? "tenant" : "other";
    // A populated company (a document) stands for its id.
    const populatedId: unknown = Reflect.get(value, "_id");
    if (populatedId !== undefined) return companyVerdict(populatedId, tenant);
    const operators: Record<string, unknown> = {...value};
    const keys = Object.keys(operators);
    if (keys.length === 1 && keys[0] === "$eq") return companyVerdict(operators.$eq, tenant);
    if (keys.length === 1 && keys[0] === "$in" && Array.isArray(operators.$in)) {
        if (operators.$in.length === 0) return "absent";
        return operators.$in.every((entry) => companyVerdict(entry, tenant) === "tenant") ? "tenant" : "other";
    }
    return "other";
}

function refuse(finding: Finding, model: string, operation: string, scope: Scope): Error {
    logger.err(`Tenant scope refused ${model}.${operation} (${finding}) in ${scope.module ?? "no module"}`);
    return finding === "no-tenant"
        ? apiValidationException("tenant_context_missing", "company", [model], scope.languageCode)
        : apiValidationException("tenant_scope_violation", "company", [model], scope.languageCode);
}

/**
 * Decides one filter's fate. Returns the error to raise, or undefined; `addTenant` is called when the
 * filter must be narrowed to the tenant.
 */
function judge(companyFilter: unknown, model: string, operation: string, addTenant: (tenant: string) => void): Error | undefined {
    const scope = currentScope();
    if (!scope) return undefined;
    if (!scope.tenant) return refuse("no-tenant", model, operation, scope);
    const verdict = companyVerdict(companyFilter, scope.tenant);
    if (verdict === "other") return refuse("other-company", model, operation, scope);
    if (verdict === "absent") addTenant(scope.tenant);
    return undefined;
}

/** `value[key]` when `value` is a plain object carrying it. */
function fieldOf(value: unknown, key: string): unknown {
    if (value === null || typeof value !== "object" || Array.isArray(value) || !(key in value)) return undefined;
    return Object.entries(value).find(([name]) => name === key)?.[1];
}

/** The `company` an update would write, if any. */
function updatedCompany(update: unknown): unknown {
    return fieldOf(fieldOf(update, "$set"), "company")
        ?? fieldOf(fieldOf(update, "$setOnInsert"), "company")
        ?? fieldOf(update, "company");
}

/** The filter that keeps a query inside the tenant: owned by it, or (shared models) shared with it. */
function tenantCondition(tenant: string, sharedWith: string | undefined): Record<string, unknown> {
    const company = new Types.ObjectId(tenant);
    return sharedWith ? {$or: [{company}, {[sharedWith]: company}]} : {company};
}

function applyTenantScope(schema: Schema, sharedWith?: string): void {
    for (const operation of SCOPED_QUERIES) {
        schema.pre(operation, function (this: Query<unknown, unknown>, next: (error?: Error) => void) {
            const model = this.model.modelName;
            // `and` keeps a filter's own `$or` intact.
            const error = judge(this.getFilter().company, model, operation, (tenant) => this.and([tenantCondition(tenant, sharedWith)]));
            if (error) return next(error);
            const written = updatedCompany(this.getUpdate());
            next(written === undefined ? undefined : judge(written, model, `${operation}:write`, () => undefined));
        });
    }

    schema.pre("aggregate", function (this: Aggregate<unknown>, next: (error?: Error) => void) {
        const pipeline = this.pipeline();
        const model = this.model().modelName;
        const insertAt = pipelineFilterIndex(pipeline);
        const leadingMatch = pipeline[insertAt];
        const matched = leadingMatch && "$match" in leadingMatch ? leadingMatch.$match.company : undefined;
        const error = judge(matched, model, "aggregate", (tenant) => {
            const stage: PipelineStage = {$match: tenantCondition(tenant, sharedWith)};
            pipeline.splice(insertAt, 0, stage);
        });
        next(error);
    });

    schema.pre("save", function (this: Document, next: (error?: Error) => void) {
        if (!this.isNew && !this.isModified("company")) return next();
        const model = this.constructor && "modelName" in this.constructor ? String(this.constructor.modelName) : "document";
        next(judge(this.get("company"), model, "save", () => undefined));
    });

    schema.pre("insertMany", function (next: (error?: Error) => void, docs: unknown) {
        const model = "modelName" in this ? String(this.modelName) : "model";
        for (const doc of Array.isArray(docs) ? docs : [docs]) {
            const error = judge(fieldOf(doc, "company"), model, "insertMany", () => undefined);
            if (error) return next(error);
        }
        next();
    });

    // Mongoose 6 runs no middleware for bulkWrite (TD-B114): each op is judged like the matching query, and an
    // inserted document without a company gets the tenant's (Mongoose validates it after this hook).
    preBulkWrite(schema, (model, ops) => {
        for (const op of ops) {
            if (!isPlainRecord(op)) continue;
            for (const [kind, spec] of Object.entries(op)) {
                if (!isPlainRecord(spec)) continue;
                const operation = `bulkWrite.${kind}`;
                if (kind === "insertOne") {
                    const document = spec.document;
                    if (!isPlainRecord(document)) continue;
                    const error = judge(document.company, model.modelName, operation, (tenant) => {
                        document.company = new Types.ObjectId(tenant);
                    });
                    if (error) throw error;
                    continue;
                }
                const filter = spec.filter;
                if (!isPlainRecord(filter)) continue;
                // Appending to `$and` keeps the filter's own keys (and its `$or`) where Mongoose looks for them.
                const error = judge(filter.company, model.modelName, operation, (tenant) => {
                    const and = filter.$and;
                    const condition = tenantCondition(tenant, sharedWith);
                    filter.$and = and === undefined ? [condition] : Array.isArray(and) ? [...and, condition] : [and, condition];
                });
                if (error) throw error;
                const written = kind === "replaceOne" ? fieldOf(spec.replacement, "company") : updatedCompany(spec.update);
                if (written === undefined) continue;
                const writeError = judge(written, model.modelName, `${operation}:write`, () => undefined);
                if (writeError) throw writeError;
            }
        }
    });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

export default ownershipPlugin;
