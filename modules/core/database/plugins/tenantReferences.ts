import {ClientSession, Document, Model, MongooseQueryMiddleware, Query, Schema, SchemaType, Types} from "mongoose";
import {apiValidationException, DEFAULT_EXCEPTION_LANGUAGE} from "armonia/src/modules/core/helpers/exceptions";
import {getLogger} from "@coreModule/loggers/serverLog";
import {requestContext} from "@coreModule/utilities/endpoints/requestContext";
import {preBulkWrite} from "@coreModule/database/plugins/bulkWriteHooks";
import {isRequestable, UNUSABLE_REQUEST_STATUSES} from "@coreModule/database/plugins/requestablePlugin";

/*
 * Stored references stay inside the tenant (D104, SEC-05). The tenant scope (D16) limits what a query reads; it does not
 * look at the ids a write stores. On every create and update of a tenant record, each reference to a tenant-owned model
 * (`ref: "<Model>"`, arrays of refs and refs inside sub-documents included) must name a row of the record's company,
 * or, for a model that shares rows (`ownershipPlugin({sharedWith})`, e.g. Media), a row shared with it. Otherwise the
 * write is refused with `reference_outside_tenant` (403).
 *
 * - Targets without tenant ownership (User, Company, RolePermission, any model without the tenant scope) are not
 *   tenant-owned: a reference to them is never checked.
 * - Records without the tenant scope name their company elsewhere (`owner`): Company's references must be its own rows,
 *   and each of a User's memberships (`roles[]`) may hold only roles of that membership's company.
 * - An id that names no row is left to the caller: it points at nothing, so it leaks nothing.
 * - One `$in` lookup per target model per write, in the write's session, through the collection (no plugins, so soft-
 *   deleted rows count and no read is audited). A save checks only the references it changed; an update only the
 *   references it sets. Covers save/create, insertMany, update queries, update pipelines (literal ids only) and the
 *   model's `bulkWrite` (Mongoose 6 runs no middleware for it, `bulkWriteHooks.ts`).
 * - `allowForeignReferences` (tenantScope.ts) lets a named block store named fields that point at another company.
 * - A reference to a requestable platform list row (requestablePlugin, D160) that the platform has not approved is
 *   refused with `reference_not_approved`, unless the write is the platform's: the session acts in the row's company.
 *   The pickers hide such rows; this keeps a hand-written call from storing them (TD-B233). It judges the session, not
 *   the record, since some records live in the platform company for everyone (UserAddress, D163). Models without the
 *   tenant scope get this check alone (`checkRequestableReferences`); `allowForeignReferences` does not lift it.
 */

const logger = getLogger("tenantReferences");

/** Tenant-owned schemas and the field naming the companies a row is shared with (ownershipPlugin). */
const tenantOwned = new WeakMap<Schema, {sharedWith?: string}>();

/** Called by ownershipPlugin for every tenant-scoped schema. */
export function markTenantOwned(schema: Schema, sharedWith?: string): void {
    tenantOwned.set(schema, {sharedWith});
}

/** True when the tenant scope (D16) narrows every read of this schema's model to the current company. */
export function isTenantOwned(schema: Schema): boolean {
    return tenantOwned.has(schema);
}

/** Fields a block may point outside the record's company, and why (`allowForeignReferences`). */
export interface ForeignReferenceAllowance {
    /** Why these fields may name another company's rows, for the log. */
    reason: string;
    /** `<Model>.<path>` without array positions, e.g. `ProductOrder.items.product`. Every other reference stays checked. */
    fields: readonly string[];
}

interface RefPath {
    /** `items.product`: the schema path without array positions. */
    path: string;
    segments: string[];
    target: string;
}

/** Where a record names the company its references must belong to. */
interface Owner {
    /** The array whose entries each name their own company (`roles` for `roles.company`); empty for the record itself. */
    scope: string[];
    field: string;
}

const refPathCache = new WeakMap<Schema, RefPath[]>();

function refTarget(type: SchemaType): string | undefined {
    const options = type.options as {ref?: unknown; type?: unknown};
    const caster = (type as SchemaType & {caster?: SchemaType}).caster;
    const elementType = Array.isArray(options.type) ? options.type[0] as {ref?: unknown} | undefined : undefined;
    const ref = options.ref ?? caster?.options?.ref ?? elementType?.ref;
    if (typeof ref === "string") return ref;
    if (typeof ref === "function" && "modelName" in ref && typeof ref.modelName === "string") return ref.modelName;
    return undefined;
}

/** Every reference path of a schema, sub-documents and arrays of them included. */
function refPathsOf(schema: Schema, prefix: string[] = []): RefPath[] {
    const cached = prefix.length === 0 ? refPathCache.get(schema) : undefined;
    if (cached) return cached;
    const paths: RefPath[] = [];
    schema.eachPath((name, type) => {
        const segments = [...prefix, ...name.split(".")];
        const nested = (type as SchemaType & {schema?: Schema}).schema;
        if (nested) {
            paths.push(...refPathsOf(nested, segments));
            return;
        }
        const target = refTarget(type);
        if (target) paths.push({path: segments.join("."), segments, target});
    });
    if (prefix.length === 0) refPathCache.set(schema, paths);
    return paths;
}

function allowed(model: string, ref: RefPath): boolean {
    const allowance = requestContext.getStore()?.foreignReferences;
    return allowance?.fields.includes(`${model}.${ref.path}`) ?? false;
}

/**
 * The reference paths this write must check: their target is requestable, or (`tenantRefs`) tenant-owned and no
 * allowance names them.
 */
function checkedRefs(schema: Schema, model: Model<unknown>, tenantRefs: boolean): RefPath[] {
    return refPathsOf(schema).filter((ref) => {
        const target = model.db.models[ref.target] as Model<unknown> | undefined;
        if (!target) return false;
        if (isRequestable(target)) return true;
        return tenantRefs && tenantOwned.has(target.schema) && !allowed(model.modelName, ref);
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** An object written as a value (an id, a date), not a document or operator object to walk into. */
const isScalarObject = (value: object) => value instanceof Types.ObjectId || value instanceof Date;

const HEX_ID = /^[0-9a-f]{24}$/i;

/** The id a stored value names: an ObjectId, its hex string, or a populated / legacy `{_id}` shape. */
function idOf(value: unknown): string | undefined {
    if (value === null || value === undefined) return undefined;
    if (typeof value === "string") return HEX_ID.test(value) ? value.toLowerCase() : undefined;
    if (typeof value !== "object") return undefined;
    if (value instanceof Types.ObjectId) return value.toHexString();
    const inner: unknown = Reflect.get(value, "_id");
    return inner !== undefined && inner !== value ? idOf(inner) : undefined;
}

function fieldOf(value: unknown, field: string): unknown {
    if (value instanceof Document) return value.get(field);
    return isRecord(value) ? value[field] : undefined;
}

/** Collects the values under `segments` of `value` (a document, sub-document, plain object or array of them). */
function collectValues(value: unknown, segments: readonly string[], into: unknown[]): void {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
        for (const entry of value) collectValues(entry, segments, into);
        return;
    }
    if (segments.length === 0) {
        into.push(value);
        return;
    }
    if (typeof value !== "object") return;
    const [head, ...rest] = segments;
    collectValues(fieldOf(value, head), rest, into);
}

function collectIds(value: unknown, segments: readonly string[], into: string[]): void {
    const values: unknown[] = [];
    collectValues(value, segments, values);
    for (const entry of values) {
        const id = idOf(entry);
        if (id) into.push(id);
    }
}

/** `items.3.product` / `items.$[line].product` → `["items", "product"]`. */
const schemaSegments = (key: string) => key.split(".").filter((segment) => !/^\d+$/.test(segment) && !segment.startsWith("$"));

const isPrefix = (prefix: readonly string[], of: readonly string[]) => prefix.length <= of.length && prefix.every((segment, i) => of[i] === segment);

/** The ids each reference path receives from `[key, value]` writes (an update's `$set`, a replacement, …). */
function idsFromWrites(refs: RefPath[], writes: [string, unknown][]): Map<RefPath, string[]> {
    const found = new Map<RefPath, string[]>();
    for (const [key, value] of writes) {
        const keySegments = schemaSegments(key);
        for (const ref of refs) {
            if (!isPrefix(keySegments, ref.segments)) continue;
            const ids = found.get(ref) ?? [];
            collectIds(value, ref.segments.slice(keySegments.length), ids);
            if (ids.length > 0) found.set(ref, ids);
        }
    }
    return found;
}

/** A pipeline value with its `$literal` wrappers taken off; only literal values reach the reference check. */
function literalValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(literalValue);
    if (!isRecord(value) || isScalarObject(value) || value instanceof Document) return value;
    if ("$literal" in value) return value.$literal;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, literalValue(entry)]));
}

/** What an update (operators, a replacement or a pipeline) writes, as `[path, value]` pairs. `$unset`/`$pull` store no id. */
function updateWrites(update: unknown): [string, unknown][] {
    if (Array.isArray(update)) {
        return update.flatMap((stage: unknown) => isRecord(stage)
            ? Object.entries(stage).flatMap(([key, value]): [string, unknown][] => (key === "$set" || key === "$addFields") && isRecord(value)
                ? Object.entries(value).map(([path, set]) => [path, literalValue(set)])
                : [])
            : []);
    }
    if (!isRecord(update)) return [];
    return Object.entries(update).flatMap(([key, value]): [string, unknown][] => {
        if (!key.startsWith("$")) return [[key, value]];
        if (!isRecord(value)) return [];
        if (key === "$set" || key === "$setOnInsert") return Object.entries(value);
        if (key === "$push" || key === "$addToSet") {
            return Object.entries(value).map(([path, added]) => [path, isRecord(added) && "$each" in added ? added.$each : added]);
        }
        return [];
    });
}

/** Pipeline stages that may rewrite any field. */
const WHOLE_DOCUMENT_STAGES = new Set(["$project", "$replaceRoot", "$replaceWith"]);

/** Whether a pipeline value computes what lands under `segments` (a `$field` path or an operator) instead of stating it. */
function isExpression(value: unknown, segments: readonly string[]): boolean {
    if (typeof value === "string") return value.startsWith("$");
    if (Array.isArray(value)) return value.some((entry) => isExpression(entry, segments));
    if (!isRecord(value) || isScalarObject(value) || "$literal" in value) return false;
    if (Object.keys(value).some((key) => key.startsWith("$"))) return true;
    if (segments.length === 0) return false;
    const [head, ...rest] = segments;
    return isExpression(value[head], rest);
}

/**
 * An update pipeline can compute a reference from other fields, which no check before the write can see. A checked
 * reference path may only receive literal ids there; anything else is a programming error, refused before it runs.
 */
function refuseComputedReferences(modelName: string, refs: RefPath[], update: unknown): void {
    if (!Array.isArray(update) || refs.length === 0) return;
    const refuse = (ref: RefPath, how: string) => new Error(
        `${modelName}.${ref.path}: an update pipeline that sets it with ${how} cannot be checked against the tenant (D104). `
        + "Set a literal id with $set, or write it with an operator update or save().",
    );
    for (const stage of update) {
        if (!isRecord(stage)) continue;
        for (const [operator, spec] of Object.entries(stage)) {
            if (WHOLE_DOCUMENT_STAGES.has(operator)) throw refuse(refs[0], operator);
            if ((operator !== "$set" && operator !== "$addFields") || !isRecord(spec)) continue;
            for (const [key, value] of Object.entries(spec)) {
                const keySegments = schemaSegments(key);
                const computed = refs.find((ref) => isPrefix(keySegments, ref.segments) && isExpression(value, ref.segments.slice(keySegments.length)));
                if (computed) throw refuse(computed, "an expression");
            }
        }
    }
}

/** References one write sets, and the companies the rows they name must belong to. */
interface ReferenceGroup {
    ids: Map<RefPath, string[]>;
    /** Resolved only when a checked reference is set. */
    companies: () => Promise<string[]>;
}

/**
 * Groups `[path, value]` writes by owner. For the record itself, one group judged by `companies`; for owners inside an
 * array (User `roles[].company`), one group per written entry, judged by that entry's company. A write inside an entry
 * that sets a reference without its entry's company cannot be judged and is refused.
 */
function referenceGroups(refs: RefPath[], owner: Owner, writes: [string, unknown][], companies: () => Promise<string[]>, modelName: string): ReferenceGroup[] {
    if (owner.scope.length === 0) return [{ids: idsFromWrites(refs, writes), companies}];
    const scoped = refs.filter((ref) => isPrefix(owner.scope, ref.segments));
    const groups: ReferenceGroup[] = [];
    for (const [key, value] of writes) {
        const keySegments = schemaSegments(key);
        if (isPrefix(keySegments, owner.scope)) {
            const entries: unknown[] = [];
            collectValues(value, owner.scope.slice(keySegments.length), entries);
            for (const entry of entries) {
                const company = idOf(fieldOf(entry, owner.field));
                if (!company) continue;
                const ids = new Map<RefPath, string[]>();
                for (const ref of scoped) {
                    const found: string[] = [];
                    collectIds(entry, ref.segments.slice(owner.scope.length), found);
                    if (found.length > 0) ids.set(ref, found);
                }
                groups.push({ids, companies: async () => [company]});
            }
        } else if (isPrefix(owner.scope, keySegments)) {
            const [ref] = idsFromWrites(scoped, [[key, value]]).keys();
            if (ref) {
                throw new Error(`${modelName}.${ref.path}: write the whole ${owner.scope.join(".")} entry (with its ${owner.field}) or use save(), `
                    + "so the company its references must belong to is known (D104)");
            }
        }
    }
    return groups;
}

/** A whole record being inserted (create, insertMany, a bulk insert). */
function recordGroups(refs: RefPath[], owner: Owner, record: unknown, modelName: string): ReferenceGroup[] {
    const plain: unknown = record instanceof Document ? record.toObject({depopulate: true}) : record;
    if (!isRecord(plain)) return [];
    // A record without a company is judged by no company (tenant references pass), the session still by its own.
    const company = owner.scope.length === 0 ? idOf(plain[owner.field]) : undefined;
    return referenceGroups(refs, owner, Object.entries(plain), async () => (company ? [company] : []), modelName);
}

/** What a save writes to reference paths: every reference on a create, the changed ones otherwise. */
function savedWrites(refs: RefPath[], doc: Document): {refs: RefPath[]; writes: [string, unknown][]} {
    const changed = doc.isNew ? undefined : doc.directModifiedPaths().map(schemaSegments);
    const saved = changed ? refs.filter((ref) => changed.some((segments) => isPrefix(segments, ref.segments) || isPrefix(ref.segments, segments))) : refs;
    const fields = [...new Set(saved.map((ref) => ref.segments[0]))];
    return {refs: saved, writes: fields.map((field) => [field, doc.get(field)])};
}

/**
 * Refuses the write when a reference names a tenant-owned row outside the company it must belong to, or a requestable
 * row the platform has not approved.
 */
async function assertReferencesInTenant(model: Model<unknown>, groups: ReferenceGroup[], session: ClientSession | null | undefined): Promise<void> {
    type Target = {model: Model<unknown>; tenantOwned: boolean; requestable: boolean; sharedWith?: string; uses: Map<string, {ref: RefPath; group: number}[]>};
    const byTarget = new Map<string, Target>();
    groups.forEach((group, index) => {
        for (const [ref, ids] of group.ids) {
            const target = model.db.models[ref.target] as Model<unknown> | undefined;
            const ownership = target ? tenantOwned.get(target.schema) : undefined;
            const requestable = !!target && isRequestable(target);
            if (!target || (!ownership && !requestable)) continue;
            const entry = byTarget.get(ref.target)
                ?? {model: target, tenantOwned: !!ownership, requestable, sharedWith: ownership?.sharedWith, uses: new Map()};
            for (const id of ids) {
                const uses = entry.uses.get(id) ?? [];
                if (!uses.some((use) => use.ref === ref && use.group === index)) uses.push({ref, group: index});
                entry.uses.set(id, uses);
            }
            byTarget.set(ref.target, entry);
        }
    });
    if (byTarget.size === 0) return;

    const companies = new Map<number, string[]>();
    for (const {tenantOwned: owned, uses} of byTarget.values()) {
        if (!owned) continue;
        for (const {group} of [...uses.values()].flat()) {
            if (!companies.has(group)) companies.set(group, await groups[group].companies());
        }
    }
    for (const {model: target, tenantOwned: owned, requestable, sharedWith, uses} of byTarget.values()) {
        const projection: Record<string, 1> = {company: 1, ...(sharedWith ? {[sharedWith]: 1} : {}), ...(requestable ? {requestStatus: 1} : {})};
        const rows = await target.collection
            .find({_id: {$in: [...uses.keys()].map((id) => new Types.ObjectId(id))}}, {projection, session: session ?? undefined})
            .toArray();
        for (const row of rows) {
            const rowOwner = idOf(row.company);
            const rowUses = uses.get(idOf(row._id) ?? "") ?? [];
            const store = requestContext.getStore();
            // A write outside any company's session is not the platform's either.
            if (requestable && UNUSABLE_REQUEST_STATUSES.includes(row.requestStatus) && (!rowOwner || store?.tenantCompanyId !== rowOwner)) {
                const field = rowUses[0]?.ref.path ?? "";
                logger.err(`Refused ${model.modelName}.${field}: ${target.modelName} ${idOf(row._id)} is ${String(row.requestStatus)} (${store?.routeModule ?? "no module"})`);
                throw apiValidationException("reference_not_approved", field, [`${model.modelName}.${field}`], store?.languageCode ?? DEFAULT_EXCEPTION_LANGUAGE, [field]);
            }
            if (!owned) continue;
            const sharedValue: unknown = sharedWith ? row[sharedWith] : undefined;
            const shared = Array.isArray(sharedValue) ? sharedValue.map(idOf) : [];
            // No company resolved (nothing matched) judges nothing.
            const foreign = rowUses
                .find(({group}) => !(companies.get(group) ?? []).every((company) => company === rowOwner || shared.includes(company)));
            if (!foreign) continue;
            const field = foreign.ref.path;
            logger.err(`Refused ${model.modelName}.${field}: ${target.modelName} ${idOf(row._id)} belongs to another company (${store?.routeModule ?? "no module"})`);
            throw apiValidationException("reference_outside_tenant", field, [`${model.modelName}.${field}`], store?.languageCode ?? DEFAULT_EXCEPTION_LANGUAGE, [field]);
        }
    }
}

/** The `company` an update writes, if any (an upsert's insert, or a move). */
function writtenCompany(update: unknown): string | undefined {
    if (!isRecord(update)) return undefined;
    const set = update.$set, setOnInsert = update.$setOnInsert;
    return idOf(isRecord(set) ? set.company : undefined) ?? idOf(isRecord(setOnInsert) ? setOnInsert.company : undefined) ?? idOf(update.company);
}

/**
 * The companies whose records an update changes: the company it writes, the request's tenant when the write is
 * tenant-scoped (ownershipPlugin's hook has already limited its filter), the one its filter names, else every one
 * its filter matches.
 */
async function updatedCompanies(owner: Owner, filter: Record<string, unknown>, update: unknown, scoped: boolean, distinct: () => Promise<unknown[]>): Promise<string[]> {
    const written = owner.field === "company" ? writtenCompany(update) : undefined;
    if (written) return [written];
    const store = requestContext.getStore();
    if (scoped && store?.tenantCompanyId && !store.crossTenantReason) return [store.tenantCompanyId];
    const filtered = idOf(filter[owner.field]);
    if (filtered) return [filtered];
    return (await distinct()).flatMap((company) => idOf(company) ?? []);
}

const UPDATE_QUERIES: MongooseQueryMiddleware[] = ["findOneAndReplace", "findOneAndUpdate", "replaceOne", "update", "updateMany", "updateOne"];

/**
 * Adds the reference check to a schema. `owner` is the path naming the company its references must belong to:
 * `company` for every tenant-scoped model (ownershipPlugin), `_id` for Company (its own rows), `roles.company` for
 * User (each membership's roles belong to that membership's company).
 */
export function checkTenantReferences(schema: Schema, ownerPath = "company"): void {
    addReferenceChecks(schema, ownerPath, true);
}

/**
 * Adds only the requestable-row check (TD-B233) to a model without the tenant scope (ownershipPlugin
 * `tenantScoped: false`, e.g. UserAddress, the platform lists themselves).
 */
export function checkRequestableReferences(schema: Schema): void {
    addReferenceChecks(schema, "company", false);
}

function addReferenceChecks(schema: Schema, ownerPath: string, tenantRefs: boolean): void {
    const ownerSegments = ownerPath.split(".");
    const owner: Owner = {scope: ownerSegments.slice(0, -1), field: ownerSegments[ownerSegments.length - 1]};
    // Only ownershipPlugin's tenant-scoped models have their update filters limited to the tenant (D16).
    const scoped = tenantRefs && ownerPath === "company";

    schema.pre("save", async function (this: Document) {
        const model = this.constructor as Model<unknown>;
        const refs = checkedRefs(schema, model, tenantRefs);
        if (refs.length === 0) return;
        const saved = savedWrites(refs, this);
        if (saved.writes.length === 0) return;
        const company = owner.scope.length === 0 ? idOf(this.get(owner.field)) : undefined;
        const groups = referenceGroups(saved.refs, owner, saved.writes, async () => (company ? [company] : []), model.modelName);
        await assertReferencesInTenant(model, groups, this.$session());
    });

    schema.pre(UPDATE_QUERIES, async function (this: Query<unknown, unknown>) {
        const refs = checkedRefs(schema, this.model, tenantRefs);
        if (refs.length === 0) return;
        const update = this.getUpdate();
        refuseComputedReferences(this.model.modelName, refs, update);
        const session: ClientSession | null | undefined = this.getOptions().session;
        const filter = this.getFilter();
        const companies = () => updatedCompanies(owner, filter, update, scoped, () => this.model.distinct(owner.field, filter).session(session ?? null).exec());
        await assertReferencesInTenant(this.model, referenceGroups(refs, owner, updateWrites(update), companies, this.model.modelName), session);
    });

    schema.pre("insertMany", function (this: Model<unknown>, next: (error?: Error) => void, docs: unknown, ...rest: unknown[]) {
        const refs = checkedRefs(schema, this, tenantRefs);
        if (refs.length === 0) return next();
        // Mongoose passes insertMany's options after the documents.
        const options = rest[0];
        const session = isRecord(options) ? options.session as ClientSession | undefined : undefined;
        let groups: ReferenceGroup[];
        try {
            groups = (Array.isArray(docs) ? docs : [docs]).flatMap((record: unknown) => recordGroups(refs, owner, record, this.modelName));
        } catch (error) {
            return next(error instanceof Error ? error : new Error(String(error)));
        }
        assertReferencesInTenant(this, groups, session).then(() => next(), next);
    });

    // ownershipPlugin's bulkWrite hook (registered first) has already limited a tenant-scoped model's filters (TD-B114);
    // otherwise (cross-tenant, Company, User) an update's companies come from what its filter matches.
    preBulkWrite(schema, async (model, ops, {session}) => {
        const refs = checkedRefs(schema, model, tenantRefs);
        if (refs.length === 0) return;
        const groups: ReferenceGroup[] = [];
        for (const op of ops) {
            if (!isRecord(op)) continue;
            for (const [kind, spec] of Object.entries(op)) {
                if (!isRecord(spec)) continue;
                if (kind === "insertOne") {
                    groups.push(...recordGroups(refs, owner, spec.document, model.modelName));
                    continue;
                }
                const update = kind === "replaceOne" ? spec.replacement : kind === "updateOne" || kind === "updateMany" ? spec.update : undefined;
                if (update === undefined) continue;
                refuseComputedReferences(model.modelName, refs, update);
                const filter = isRecord(spec.filter) ? spec.filter : {};
                const matched = async (): Promise<unknown[]> => {
                    const cast: unknown = model.find(filter).cast(model);
                    return model.collection.distinct(owner.field, isRecord(cast) ? cast : {}, {session: session ?? undefined});
                };
                groups.push(...referenceGroups(refs, owner, updateWrites(update), () => updatedCompanies(owner, filter, update, scoped, matched), model.modelName));
            }
        }
        await assertReferencesInTenant(model, groups, session);
    });
}
