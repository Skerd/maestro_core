import {Router, RequestHandler} from "express";
import {ObjectId} from "mongodb";
import {Document, Model, RefAllowlist} from "mongoose";
import {ZodObject} from "zod";
import {asyncHandler} from "@coreModule/utilities/middlewares/asyncHandler";
import {transactionHandler} from "@coreModule/utilities/middlewares/transactionHandler";
import {getRegisteredActions} from "@coreModule/api/actionDecorator";
import {TransactionRequiredParams} from "@coreModule/utilities/middlewares/transactionUtils";
import authMW, {AuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import {rateLimiter} from "@coreModule/utilities/middlewares/rateLimiter";
import {schemaSanitizer, SchemaSanitizerMWType} from "@coreModule/utilities/middlewares/schemaSanitizerMW";
import {dslFilterMW, DslFilterMWType} from "@coreModule/utilities/middlewares/dslFilterMW";
import {validateFormZod} from "@coreModule/utilities/middlewares/validateFormZod";
import SchemaGuard from "@coreModule/database/security/schemaGuard";
import {COLLECTED_DATA, getModelCollectedData} from "@coreModule/database/collections";
import {BaseCrudService} from "@coreModule/database/services/baseCrudService";
import {assertCanDelete} from "@coreModule/database/relationsRegistry";
import {escapeRegex} from "@coreModule/utilities/helpers";
import {DeletedDataReadFields, UnSanitizedFields} from "armonia/src/modules/core/types";
import {
    validateDeleteForm,
    validateRestoreForm,
    validateSelectForm,
    validateSingleForm,
    validateTableForm,
} from "armonia/src/modules/core/utilities/zod/shared.validator";
import type {
    ApiSelectDatum,
    DeleteForm,
    DeleteResponse,
    RestoreForm,
    RestoreResponse,
    SelectForm,
    SelectResponse,
    SingleForm,
    TableForm,
    TableResponse,
} from "armonia/src/modules/core/types/shared.types";

// ── Config ────────────────────────────────────────────────────────────────────

export interface CrudRouterConfig<T extends Document> {
    /** Collection name used by schemaSanitizer (e.g. "countries"). */
    collectionName: string;
    /** The Mongoose model. */
    model: Model<T>;
    /** Service instance extending BaseCrudService. */
    service: BaseCrudService<T, any>;

    /**
     * Zod schema factory for the table/list route.
     * Defaults to the standard `validateTableForm` (pagination + sort + filter).
     * Override only when the list endpoint needs extra validated fields.
     */
    listSchema?: (lang: string, form: any) => ZodObject<any>;

    /**
     * Zod schema factory for the select/dropdown route.
     * Defaults to the standard `validateSelectForm`.
     * Override when the select endpoint needs extra validated fields (e.g. a parent-entity filter).
     */
    selectSchema?: (lang: string, form: any) => ZodObject<any>;

    /**
     * Extra MongoDB filter entries merged into the select route's base `{company}` filter.
     * Receives the validated request params after schema validation.
     * May be async to support service lookups (e.g. resolving parent entities).
     */
    extraSelectFilter?: (params: Record<string, any>) => Record<string, unknown> | Promise<Record<string, unknown>>;

    /**
     * Extra MongoDB filter entries merged into the list route's base `{company}` filter.
     * Receives the validated request params after schema validation.
     * May be async to support service lookups (e.g. resolving parent entities).
     */
    extraListFilter?: (params: Record<string, any>) => Record<string, unknown> | Promise<Record<string, unknown>>;

    /**
     * When provided, replaces the default `{ company: company._id }` guard on
     * single / update / delete / restore (merged with `_id` where applicable).
     * Use for models with nullable `company` (e.g. platform-global cron jobs).
     */
    documentFilter?: (params: Record<string, any>) => Record<string, unknown> | Promise<Record<string, unknown>>;

    /**
     * When provided, replaces the built-in select route handler entirely.
     * The middleware chain (auth, rate limiting, schema validation) still runs.
     * Use when the select endpoint requires logic incompatible with the default
     * single-field search (e.g. multi-field search, cross-collection lookups).
     */
    overrideSelectHandler?: (params: Record<string, any>) => Promise<SelectResponse>;

    /** Zod schema factory for the create route. */
    createSchema: (lang: string, form: any) => ZodObject<any>;

    /** Zod schema factory for the edit route (receives write + read permission maps). */
    editSchema: (lang: string, form: any, writePerms: any, readPerms: any) => ZodObject<any>;

    /** Maps a single Mongoose document to its API DTO shape. */
    toDTO: (doc: T) => unknown;

    /** Maps an array of Mongoose documents to their API DTO shape. */
    toDTOArray: (docs: T[]) => unknown[];

    /**
     * Maps documents to `{ value, label }` pairs for dropdown selects.
     * The select route filters documents by `selectSearchField` (default "name").
     */
    toSelect: (docs: T[]) => ApiSelectDatum[];

    /**
     * Builds the data object passed to `service.create()`.
     * `company` is appended automatically — do not include it here.
     * Receives the full validated request body (including `session`, `logger`, `languageCode`).
     * May be async to support service lookups (e.g. resolving a parent entity by id).
     */
    buildCreateData: (params: Record<string, any>) => Record<string, any> | Promise<Record<string, any>>;

    /**
     * Builds the `$set` object passed to `service.updateById()`.
     * Called with the validated request body and the user's write-permission map.
     * Must check `writeFields[key]` before including each field.
     * May be async to support service lookups (e.g. resolving a parent entity by id).
     */
    buildUpdateData: (
        params: Record<string, any>,
        writeFields: Record<string, any>,
    ) => Record<string, any> | Promise<Record<string, any>>;

    /**
     * Field name searched in the select route (case-insensitive regex).
     * @default "name"
     */
    selectSearchField?: string;

    /** Used in log messages. Defaults to `model.modelName`. */
    entityName?: string;

    /** Extra middleware inserted in the PUT route after rateLimiter (e.g. `mediaUploadMW`). */
    createMiddleware?: RequestHandler[];

    /** Extra middleware inserted in the PATCH route after rateLimiter (e.g. `mediaUploadMW`). */
    editMiddleware?: RequestHandler[];

    /**
     * Called after `service.create()` completes (within the same transaction), before the response re-fetch.
     * Receives the created document and the full request params.
     * Use for post-create side effects like updating related documents, emitting notifications, or sending emails.
     */
    afterCreate?: (created: T, params: Record<string, any>) => Promise<void>;

    /**
     * Called after `service.updateById()` completes.
     * Receives the full validated params and the pre-update document.
     * Use for side effects like deleting old media or emitting notifications.
     */
    afterUpdate?: (params: Record<string, any>, existing: T) => Promise<void>;

    /**
     * Called before deletion. Receives the full validated params and the found document.
     * Throw to abort deletion (e.g. entity is in use). When provided, replaces the default
     * `assertCanDelete` relation check so the callback owns all pre-delete validation.
     */
    beforeDelete?: (params: Record<string, any>, doc: T) => Promise<void>;

    /**
     * Called after `service.deleteById()` completes (within the same transaction).
     * Receives the full validated params and the deleted document.
     * Use for relational cleanup (e.g. removing back-references from related documents).
     */
    afterDelete?: (params: Record<string, any>, doc: T) => Promise<void>;

    /**
     * When provided, replaces the built-in restore route handler entirely.
     * The middleware chain (auth, rate limiting, form validation, transaction) still runs.
     * Use when restore requires pre-restore validation or post-restore side effects that
     * cannot be expressed as simple before/after hooks (e.g. checking related entity availability).
     * The override is responsible for calling `SchemaGuard.checkModelPermission` itself.
     */
    overrideRestoreHandler?: (params: Record<string, any>) => Promise<RestoreResponse>;

    /**
     * Replaces the default `toDTOArray(docs)` call in the list route.
     * Use when the list response needs extra async data (e.g. statistics, related counts).
     * Receives the fetched documents and the full request params.
     */
    enrichList?: (docs: T[], params: Record<string, any>) => Promise<unknown[]>;

    /**
     * Replaces the default `toDTO(doc)` call in the single route.
     * Use when the single response needs extra async data (e.g. statistics, related entities).
     * Receives the fetched document and the full request params.
     */
    enrichSingle?: (doc: T, params: Record<string, any>) => Promise<unknown>;

    /**
     * Replaces the default `toDTO(doc)` call in the update route's response.
     * Use when the update response needs extra async data (e.g. statistics).
     * Receives the re-fetched document and the full request params.
     */
    enrichUpdate?: (doc: T, params: Record<string, any>) => Promise<unknown>;

    /**
     * Action class whose methods are decorated with @action().
     * Each decorated method is registered as POST /{methodName} on this router.
     * The class is instantiated once when the router is created — handlers must be stateless.
     * Place the class in `{entity}.actions.ts` alongside the schema files.
     *
     * @example
     * ```ts
     * // edifice.actions.ts
     * export class EdificeActions {
     *   @action({ auth: "private", schema: myFormSchema })
     *   async cancelModification(params: any) { ... }
     * }
     *
     * // edifice route file
     * createCrudRouter({ ..., actions: EdificeActions })
     * // → registers POST /cancelModification
     * ```
     */
    actions?: new () => any;

    /**
     * Default sort applied to the list route when the caller provides no `sortBy`/`sortOrder`.
     * @default { createdAt: -1 }
     */
    defaultSort?: Record<string, 1 | -1>;

    /**
     * Default sort applied to the select/dropdown route.
     * @default { [selectSearchField]: 1 }
     */
    selectSort?: Record<string, 1 | -1>;

    /** Per-route rate limits (requests per minute). */
    rateLimits?: {
        /** Applied to select, list, and single routes. @default 60 */
        read?: number;
        /** Applied to create and update routes. @default 30 */
        write?: number;
        /** Applied to delete and restore routes. @default 20 */
        delete?: number;
    };
}

// ── Internal param types (merged by middleware chain) ─────────────────────────

type ReadParams   = AuthenticatedMWType & SchemaSanitizerMWType;
type WriteParams  = AuthenticatedMWType & SchemaSanitizerMWType & TransactionRequiredParams;
type DeleteParams = AuthenticatedMWType & TransactionRequiredParams & DeleteForm;
type RestoreParams = AuthenticatedMWType & TransactionRequiredParams & RestoreForm;

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Generates a fully wired Express router with 7 standard CRUD routes:
 *
 * | Method | Path       | Handler  |
 * |--------|------------|----------|
 * | POST   | /select    | dropdown list `{ value, label }[]` |
 * | POST   | /          | paginated table list               |
 * | POST   | /single    | single record by `_id`             |
 * | PUT    | /          | create                             |
 * | PATCH  | /          | update (permission-aware)          |
 * | DELETE | /          | soft-delete (relation-safe)        |
 * | PATCH  | /restore   | restore soft-deleted               |
 *
 * All routes apply `authMW("private")`, rate limiting, Zod validation,
 * SchemaGuard field sanitization, and (for write routes) transaction wrapping.
 * The DELETE route calls `assertCanDelete` before deleting.
 *
 * @example
 * export const { router } = createCrudRouter({
 *     collectionName: "countries",
 *     model: Country,
 *     service: countryService,
 *     createSchema: createCountryFormSchema,
 *     editSchema: editCountryFormSchema,
 *     toDTO: countryToDTO,
 *     toDTOArray: countriesToDTO,
 *     toSelect: countriesToSelect,
 *     buildCreateData: ({ name, code, phoneCode }) => ({ name, code: code.toUpperCase(), phoneCode }),
 *     buildUpdateData: ({ name, code, phoneCode }, w) => ({
 *         ...(name      !== undefined && w.name      && { name }),
 *         ...(code      !== undefined && w.code      && { code: code.toUpperCase() }),
 *         ...(phoneCode !== undefined && w.phoneCode && { phoneCode }),
 *     }),
 * });
 */
export function createCrudRouter<T extends Document>(config: CrudRouterConfig<T>): { router: Router } {
    const {
        collectionName,
        model,
        service,
        toDTO,
        toDTOArray,
        toSelect,
        buildCreateData,
        buildUpdateData,
        selectSearchField = "name",
        entityName = model.modelName,
        rateLimits = {},
    } = config;

    const defaultSort  = config.defaultSort  ?? {_id: -1};
    const selectSort   = config.selectSort   ?? {[selectSearchField]: 1};

    const listSchema         = config.listSchema         ?? ((lang: string, form: any) => validateTableForm(lang, form));
    const selectSchema       = config.selectSchema       ?? ((lang: string, form: any) => validateSelectForm(lang, form));
    const extraSelectFilter  = config.extraSelectFilter  ?? (() => ({}));
    const extraListFilter    = config.extraListFilter    ?? (() => ({}));
    const documentFilter     = config.documentFilter;

    async function docFilterForId(params: Record<string, any>, id: string): Promise<Record<string, unknown>> {
        if (documentFilter) {
            return {_id: new ObjectId(id), ...(await documentFilter(params))};
        }
        return {_id: new ObjectId(id), company: params.company._id};
    }

    const readLimit   = rateLimits.read    ?? 60;
    const writeLimit  = rateLimits.write   ?? 30;
    const deleteLimit = rateLimits.delete  ?? 20;

    const router = Router();

    // ── POST /select ──────────────────────────────────────────────────────────

    router.post(
        "/select",
        authMW("private"),
        rateLimiter({windowMs: 60000, max: readLimit}),
        validateFormZod((lang, form) => selectSchema(lang, form)),
        schemaSanitizer({model: collectionName, requiredModes: ["read"]}),
        dslFilterMW({model: collectionName, fieldName: "filters"}),
        asyncHandler(async (params: AuthenticatedMWType & SchemaSanitizerMWType & DslFilterMWType & SelectForm) => {
            if (config.overrideSelectHandler) {
                return config.overrideSelectHandler(params as any);
            }

            const {logger, languageCode, actionUserCtx, company, dslFilterQuery} = params;
            const name: string | undefined = (params as any)[selectSearchField];

            logger.start(`Fetching ${entityName} for select...`);

            SchemaGuard.sanitizeFields(model, {[selectSearchField]: {}}, "read", actionUserCtx, languageCode);

            const filter: Record<string, unknown> = {
                company: company._id,
                ...(await extraSelectFilter(params as any)),
            };
            if (name !== undefined && name !== "") {
                filter[selectSearchField] = {$regex: escapeRegex(String(name).trim()), $options: "i"};
            }
            if (dslFilterQuery && Object.keys(dslFilterQuery as object).length > 0) {
                filter.$and = [...((filter.$and as unknown[]) ?? []), dslFilterQuery];
            }

            const [docs, total] = await Promise.all([
                service.find(
                    filter,
                    {logger, languageCode},
                    undefined,
                    `_id ${selectSearchField}`,
                    selectSort,
                    params.limit,
                    (params.page - 1) * params.limit,
                ),
                service.count(filter, {logger, languageCode}),
            ]);

            logger.finish(`Finished fetching ${entityName} for select!`);
            return {data: toSelect(docs as T[]), total} as SelectResponse;
        }),
    );

    // ── POST / (list) ─────────────────────────────────────────────────────────

    router.post(
        "",
        authMW("private"),
        rateLimiter({windowMs: 60000, max: readLimit}),
        validateFormZod((lang, form) => listSchema(lang, form)),
        schemaSanitizer({model: collectionName, requiredModes: ["read"]}),
        dslFilterMW({model: collectionName}),
        asyncHandler(async (params: ReadParams & DslFilterMWType & TableForm) => {
            const {logger, languageCode, company, limit, offset, sortBy, sortOrder, sanitizedReadFields, dslFilterQuery} = params;

            logger.start(`Fetching ${entityName} list...`);

            const populate = SchemaGuard.generatePopulate(sanitizedReadFields, model.schema);
            const filter: Record<string, unknown> = {
                ...(documentFilter
                    ? await documentFilter(params as any)
                    : {company: company._id}),
                ...(await extraListFilter(params as any)),
            };
            if (dslFilterQuery && Object.keys(dslFilterQuery as object).length > 0) {
                filter.$and = [...((filter.$and as unknown[]) ?? []), dslFilterQuery];
            }

            const [docs, total] = await Promise.all([
                service.find(filter, {logger, languageCode}, populate.populate, populate.select || "", !!sortBy && !!sortOrder ? {[sortBy]: sortOrder === "asc" ? 1 : -1} : defaultSort, limit, offset ?? 0),
                service.count(filter, {logger, languageCode}),
            ]);

            logger.finish(`Finished fetching ${entityName} list!`);
            const listData = config.enrichList
                ? await config.enrichList(docs as T[], params as any)
                : toDTOArray(docs);
            return {data: listData, total} as TableResponse<unknown>;
        }),
    );

    // ── POST /single ──────────────────────────────────────────────────────────

    router.post(
        "/single",
        authMW("private"),
        rateLimiter({windowMs: 60000, max: readLimit}),
        validateFormZod(validateSingleForm),
        schemaSanitizer({model: collectionName, requiredModes: ["read"]}),
        asyncHandler(async (params: ReadParams & SingleForm) => {
            const {logger, languageCode, company, _id, sanitizedReadFields} = params;

            logger.start(`Fetching ${entityName} ${_id}...`);

            const populate = SchemaGuard.generatePopulate(sanitizedReadFields, model.schema);
            const doc = await service.findOneOrThrow(
                await docFilterForId(params as any, _id),
                {logger, languageCode},
                populate.populate,
                populate.select || "",
            );

            logger.finish(`Fetched ${entityName} ${_id}`);
            return config.enrichSingle
                ? await config.enrichSingle(doc, params as any)
                : toDTO(doc);
        }),
    );

    // ── PUT / (create) ────────────────────────────────────────────────────────

    router.put(
        "",
        authMW("private"),
        rateLimiter({windowMs: 60000, max: writeLimit}),
        transactionHandler(),
        ...(config.createMiddleware ?? []) as RequestHandler[],
        validateFormZod((lang, form) => config.createSchema(lang, form)),
        asyncHandler(async (params: WriteParams) => {
            const {logger, languageCode, session, company, actionUserCtx} = params;

            logger.start(`Creating ${entityName}...`);
            SchemaGuard.checkModelPermission(model, "create", actionUserCtx, languageCode);

            const createData = await buildCreateData(params as any);
            const createPayload = Object.prototype.hasOwnProperty.call(createData, "company")
                ? createData
                : {...createData, company};
            const created = await service.create(
                createPayload as unknown as Partial<T>,
                {session, logger, languageCode, auditUserId: actionUserCtx.userId},
            );

            await config.afterCreate?.(created, params as any);

            let result: unknown;
            try {
                const readFields = SchemaGuard.sanitizeFields(model, getModelCollectedData(collectionName).readFields!, "read", actionUserCtx, languageCode);
                const populate = SchemaGuard.generatePopulate(readFields, model.schema);
                const populated = await service.findOneOrThrow(
                    await docFilterForId(params as any, created._id.toString()),
                    {session, logger, languageCode},
                    populate.populate,
                    populate.select || "",
                );
                result = toDTO(populated);
            } catch {
                logger.debug(`User has no read permission on ${entityName}`);
            }

            logger.finish(`Created ${entityName} ${created._id}`);
            return result;
        }),
    );

    // ── PATCH / (update) ──────────────────────────────────────────────────────

    router.patch(
        "",
        authMW("private"),
        rateLimiter({windowMs: 60000, max: writeLimit}),
        transactionHandler(),
        ...(config.editMiddleware ?? []) as RequestHandler[],
        schemaSanitizer({model: collectionName, requiredModes: ["read", "write"]}),
        validateFormZod((lang, _form, writeFields, readFields) =>
            config.editSchema(lang, null, writeFields, readFields)
        ),
        asyncHandler(async (params: WriteParams & {_id: string}) => {
            const {logger, languageCode, session, _id, company, actionUserCtx, sanitizedWriteFields} = params;

            logger.start(`Updating ${entityName} ${_id}...`);

            const existing = await service.findOneOrThrow(
                await docFilterForId(params as any, _id),
                {session, logger, languageCode},
            );

            const updateData = await buildUpdateData({...params as any, existing}, sanitizedWriteFields ?? {});
            const $setFields: Record<string, unknown> = {};
            const $unsetFields: Record<string, string> = {};
            for (const [key, value] of Object.entries(updateData)) {
                if (value === null) $unsetFields[key] = "";
                else $setFields[key] = value;
            }
            const mongoUpdate: Record<string, unknown> = {};
            if (Object.keys($setFields).length) mongoUpdate.$set = $setFields;
            if (Object.keys($unsetFields).length) mongoUpdate.$unset = $unsetFields;
            await service.updateById(
                existing._id,
                mongoUpdate,
                {session, logger, languageCode, auditUserId: actionUserCtx.userId, returnNew: true},
            );

            await config.afterUpdate?.(params as any, existing);

            let result: unknown;
            try {
                const readFields = SchemaGuard.sanitizeFields(model, getModelCollectedData(collectionName).readFields!, "read", actionUserCtx, languageCode);
                const populate = SchemaGuard.generatePopulate(readFields, model.schema);
                const populated = await service.findOneOrThrow(
                    await docFilterForId(params as any, existing._id.toString()),
                    {session, logger, languageCode},
                    populate.populate,
                    populate.select || "",
                );
                result = config.enrichUpdate
                    ? await config.enrichUpdate(populated, params as any)
                    : toDTO(populated);
            } catch {
                logger.debug(`User has no read permission on ${entityName}`);
            }

            logger.finish(`Updated ${entityName} ${_id}`);
            return result;
        }),
    );

    // ── DELETE / (soft-delete) ────────────────────────────────────────────────

    router.delete(
        "",
        authMW("private"),
        rateLimiter({windowMs: 60000, max: deleteLimit}),
        validateFormZod(validateDeleteForm),
        transactionHandler(),
        asyncHandler(async (params: DeleteParams) => {
            const {logger, languageCode, session, _id, company, actionUserCtx} = params;

            logger.start(`Deleting ${entityName} ${_id}...`);
            SchemaGuard.checkModelPermission(model, "delete", actionUserCtx, languageCode);

            const doc = await service.findOneOrThrow(
                await docFilterForId(params as any, _id),
                {session, logger, languageCode},
            );

            if (config.beforeDelete) {
                await config.beforeDelete(params as any, doc);
            } else {
                await assertCanDelete(model.modelName, doc._id, languageCode, session);
            }

            await service.deleteById(_id, {session, logger, languageCode, auditUserId: actionUserCtx.userId});

            await config.afterDelete?.(params as any, doc);

            let response: DeleteResponse = {message: `${entityName} successfully deleted`};
            try {
                const sanitizedDelete = SchemaGuard.sanitizeFields(model, DeletedDataReadFields, "read", actionUserCtx, languageCode);
                const populate = SchemaGuard.generatePopulate(sanitizedDelete, model.schema);
                const deleted = await service.findById(doc._id, {session, logger, languageCode}, populate.populate, populate.select);
                if (deleted) {
                    response = {
                        ...response,
                        deletedAt:  sanitizedDelete.deletedAt ? (deleted as any).deletedAt : undefined,
                        deletedBy:  sanitizedDelete.deletedBy && (deleted as any).deletedBy?._id
                            ? {
                                _id:     (deleted as any).deletedBy._id.toString(),
                                name:    (deleted as any).deletedBy.name,
                                surname: (deleted as any).deletedBy.surname,
                            }
                            : undefined,
                    };
                }
            } catch {
                // no-op: user has no read permission on deleted metadata
            }

            logger.finish(`Deleted ${entityName} ${_id}`);
            return response;
        }),
    );

    // ── PATCH /restore ────────────────────────────────────────────────────────

    router.patch(
        "/restore",
        authMW("private"),
        rateLimiter({windowMs: 60000, max: deleteLimit}),
        validateFormZod(validateRestoreForm),
        transactionHandler(),
        asyncHandler(async (params: RestoreParams) => {
            if (config.overrideRestoreHandler) {
                return config.overrideRestoreHandler(params as any);
            }

            const {logger, languageCode, session, _id, actionUserCtx, company} = params;

            logger.start(`Restoring ${entityName} ${_id}...`);
            SchemaGuard.checkModelPermission(model, "restore", actionUserCtx, languageCode);

            await service.restoreOneOrThrow(
                await docFilterForId(params as any, _id),
                {session, logger, languageCode, auditUserId: actionUserCtx.userId},
            );

            logger.finish(`Restored ${entityName} ${_id}`);
            return {message: `${entityName} successfully restored`} as RestoreResponse;
        }),
    );

    // ── @action() routes ──────────────────────────────────────────────────────

    if (config.actions) {
        const registeredActions = getRegisteredActions(config.actions);
        const actionsInstance = new config.actions();
        for (const {methodName, options} of registeredActions) {
            const mw: RequestHandler[] = [];
            if (options.auth !== false) mw.push(authMW((options.auth ?? "private") as any));
            if (options.rateLimit)      mw.push(rateLimiter(options.rateLimit));
            if (options.transaction)    mw.push(transactionHandler());
            if (options.middleware?.length) mw.push(...options.middleware as RequestHandler[]);
            if (options.schema)         mw.push(validateFormZod((lang, form) => options.schema!(lang, form)));
            const handler = (actionsInstance[methodName] as Function).bind(actionsInstance);
            router.post(`/${methodName}`, ...mw, asyncHandler(handler));
        }
    }

    return {router};
}
