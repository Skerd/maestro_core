import {Aggregate, Document, MongooseQueryMiddleware, PipelineStage, Query, Schema, SchemaTypes, Types} from "mongoose";
import {apiValidationException, DEFAULT_EXCEPTION_LANGUAGE} from "armonia/src/modules/core/helpers/exceptions";
import {getLogger} from "@coreModule/loggers/serverLog";
import {requestContext} from "@coreModule/utilities/endpoints/requestContext";
import {tenantScopeEnforced} from "@coreModule/utilities/endpoints/tenantScope";

export interface OwnershipPluginOptions {
    /**
     * Whether `company` names the tenant that owns the record (default). `false` where it names
     * something else, like a company's parent company, so tenant scoping (D16) leaves the model alone.
     */
    tenantScoped?: boolean;
}

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

    // Compound index to keep tenant-scoped queries efficient
    schema.index({company: 1, _id: 1});

    if (options.tenantScoped !== false) {
        applyTenantScope(schema);
    }
};

/* ---------------------------------------------------------------------------------------------
 * Tenant scoping (D16, DB-02): queries, aggregations and writes on tenant models stay inside the
 * current company (`requestContext.tenantCompanyId`). See `tenantScope.ts` for the rollout switch.
 * ------------------------------------------------------------------------------------------- */

/** Every query that takes a filter. `estimatedDocumentCount` has none; `remove` is document middleware. */
const SCOPED_QUERIES: MongooseQueryMiddleware[] = [
    "count", "countDocuments", "deleteMany", "deleteOne", "distinct", "find", "findOne", "findOneAndDelete",
    "findOneAndRemove", "findOneAndReplace", "findOneAndUpdate", "replaceOne", "update", "updateMany", "updateOne",
];

/** Stages MongoDB requires first in a pipeline; the tenant `$match` goes right after them. */
const FIRST_ONLY_STAGES = ["$geoNear", "$search", "$searchMeta", "$collStats", "$indexStats", "$listSessions", "$changeStream"];

const logger = getLogger("tenantScope");
const reported = new Set<string>();

type Verdict = "tenant" | "absent" | "other";
type Finding = "no-tenant" | "unscoped" | "other-company";

interface Scope {
    tenant?: string;
    enforce: boolean;
    module?: string;
    languageCode: string;
}

/** The current scope, or null inside `asCrossTenant`. */
function currentScope(): Scope | null {
    const store = requestContext.getStore();
    if (store?.crossTenantReason) return null;
    return {
        tenant: store?.tenantCompanyId,
        enforce: tenantScopeEnforced(store?.routeModule),
        module: store?.routeModule,
        languageCode: store?.languageCode ?? DEFAULT_EXCEPTION_LANGUAGE,
    };
}

function hasHexId(value: object): value is {toHexString(): string} {
    return "toHexString" in value && typeof value.toHexString === "function";
}

/** How a `company` filter or value relates to the tenant. Only plain equality and an `$in` of the tenant count as the tenant. */
function companyVerdict(value: unknown, tenant: string): Verdict {
    if (value === undefined) return "absent";
    if (typeof value === "string") return value === tenant ? "tenant" : "other";
    if (value === null || typeof value !== "object") return "other";
    if (hasHexId(value)) return value.toHexString() === tenant ? "tenant" : "other";
    const operators: Record<string, unknown> = {...value};
    const keys = Object.keys(operators);
    if (keys.length === 1 && keys[0] === "$eq") return companyVerdict(operators.$eq, tenant);
    if (keys.length === 1 && keys[0] === "$in" && Array.isArray(operators.$in) && operators.$in.length > 0) {
        return operators.$in.every((entry) => companyVerdict(entry, tenant) === "tenant") ? "tenant" : "other";
    }
    if (keys.length === 1 && keys[0] === "_id") return companyVerdict(operators._id, tenant);
    return "other";
}

/** Log-only mode: one warning per finding, model, operation and module, so logs list what to fix. */
function report(finding: Finding, model: string, operation: string, scope: Scope): void {
    const key = `${finding}|${model}|${operation}|${scope.module ?? ""}`;
    if (reported.has(key)) return;
    reported.add(key);
    logger.warn(`Tenant scope would ${finding === "unscoped" ? "scope" : "refuse"} ${model}.${operation} (${finding}) in ${scope.module ?? "no module"}`);
}

function refuse(finding: Exclude<Finding, "unscoped">, model: string, operation: string, scope: Scope): Error {
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
    if (!scope.tenant) {
        if (scope.enforce) return refuse("no-tenant", model, operation, scope);
        report("no-tenant", model, operation, scope);
        return undefined;
    }
    const verdict = companyVerdict(companyFilter, scope.tenant);
    if (verdict === "tenant") return undefined;
    if (verdict === "other") {
        if (scope.enforce) return refuse("other-company", model, operation, scope);
        report("other-company", model, operation, scope);
        return undefined;
    }
    if (scope.enforce) addTenant(scope.tenant);
    else report("unscoped", model, operation, scope);
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

function applyTenantScope(schema: Schema): void {
    for (const operation of SCOPED_QUERIES) {
        schema.pre(operation, function (this: Query<unknown, unknown>, next: (error?: Error) => void) {
            const model = this.model.modelName;
            const error = judge(this.getFilter().company, model, operation, (tenant) => this.where({company: new Types.ObjectId(tenant)}));
            if (error) return next(error);
            const written = updatedCompany(this.getUpdate());
            next(written === undefined ? undefined : judge(written, model, `${operation}:write`, () => undefined));
        });
    }

    schema.pre("aggregate", function (this: Aggregate<unknown>, next: (error?: Error) => void) {
        const pipeline = this.pipeline();
        const model = this.model().modelName;
        const lead = pipeline[0];
        const insertAt = lead && FIRST_ONLY_STAGES.some((stage) => stage in lead) ? 1 : 0;
        const leadingMatch = pipeline[insertAt];
        const matched = leadingMatch && "$match" in leadingMatch ? leadingMatch.$match.company : undefined;
        const error = judge(matched, model, "aggregate", (tenant) => {
            const stage: PipelineStage = {$match: {company: new Types.ObjectId(tenant)}};
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
}

export default ownershipPlugin;
