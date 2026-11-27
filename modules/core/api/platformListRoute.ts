/**
 * CRUD options shared by the platform lists (D160): countries, states, cities and currencies belong to the platform
 * company. Every company reads, selects and links to the same rows; only a session in the platform company edits,
 * deletes or restores them. Creating is the platform's too, unless the model applies `requestablePlugin`: then another
 * company holding the model's `request` permission creates the row as a request, which only it and the platform see
 * and no select offers until the platform approves it (`requestableActions`).
 *
 * Same shape as the marketplace's shared category tree (D144).
 *
 * @module api/platformListRoute
 */

import {ObjectId} from "mongodb";
import type {RequestHandler} from "express";
import type {Model} from "mongoose";
import type {CrudRouterConfig} from "@coreModule/api/crudRouterFactory";
import type {AuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import type {BaseCrudService} from "@coreModule/database/services/baseCrudService";
import {asCrossTenant} from "@coreModule/utilities/endpoints/tenantScope";
import {assertCanDelete} from "@coreModule/database/relationsRegistry";
import SchemaGuard from "@coreModule/database/security/schemaGuard";
import {isRequestable, REQUEST_RECORD_FIELDS} from "@coreModule/database/plugins/requestablePlugin";
import {hasActionPermission} from "@coreModule/utilities/security/actionPermissions";
import {
    assertPlatformCompany,
    findPlatformCompanyId,
    isPlatformCompany,
    platformListClause,
    platformRowsClause,
} from "@coreModule/utilities/security/platformAccess";
import {decisionSet, notifyEntryRequested, notifyRequester, type RequestableEntry, requestableActions} from "@coreModule/api/requestableActions";
import {NotificationEventCodes} from "@coreModule/domain/notifications/notificationEventBus";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";

/**
 * A model's access as the access map reports it (`/api/user/permissions/access*`): a requestable platform list is
 * flagged, and outside the platform company it is read-only whatever the roles grant, since only the platform writes it.
 * The panel then shows no create, edit, delete or restore there, and offers the request instead.
 */
export function platformListAccess<A extends {write: unknown; create: boolean; delete: boolean; restore: boolean; requestable?: boolean}>(
    model: Model<any>,
    access: A,
    company: Pick<AuthenticatedMWType["company"], "isPlatformOwner">,
): A {
    if (!isRequestable(model)) return access;
    if (isPlatformCompany(company)) return {...access, requestable: true};
    return {...access, requestable: true, write: false, create: false, delete: false, restore: false};
}

/** Editing a platform list row is the platform company's. */
export const platformCompanyOnly: RequestHandler = (req, _res, next) => {
    try {
        assertPlatformCompany(req.body as AuthenticatedMWType);
        next();
    } catch (error) {
        next(error);
    }
};

type PlatformListOptions<T extends RequestableEntry, TCreate extends object> = Pick<
    CrudRouterConfig<T, TCreate>,
    "documentFilter" | "extraSelectFilter" | "checkCreatePermission" | "buildCreateData" | "afterCreate"
    | "editMiddleware" | "beforeDelete" | "afterRestore" | "actions" | "enrichList" | "enrichSingle" | "platformListCollection"
>;

/**
 * An entry as `company` may read it: the request record (who asked, when, the decision) only for the company that
 * requested the entry and for the platform; every other company reads the entry alone.
 */
export function withoutForeignRequest(dto: unknown, company: Pick<AuthenticatedMWType["company"], "_id" | "isPlatformOwner">): unknown {
    if (isPlatformCompany(company) || dto === null || typeof dto !== "object") return dto;
    const record = dto as Record<string, unknown>;
    // Only a proven requester keeps it: an entry the session cannot tie to itself (never requested, or a role that does
    // not read `requestedByCompany`) loses the record, which such an entry does not carry anyway.
    if (record.requestedByCompany === String(company._id)) return dto;
    const visible = {...record};
    for (const field of REQUEST_RECORD_FIELDS) delete visible[field];
    return visible;
}

/**
 * The options that make a CRUD router serve a platform list. `buildCreateData` is the route's own; the helper stores
 * the row in the platform company, and marks it requested when another company creates it. `collectionName` and `toDTO`
 * (the route's) shape what a decision action returns.
 */
export function platformListRouteOptions<T extends RequestableEntry, TCreate extends object>(config: {
    model: Model<T>;
    service: BaseCrudService<T, Model<T>>;
    collectionName: string;
    toDTO: (doc: T) => unknown;
    buildCreateData: CrudRouterConfig<T, TCreate>["buildCreateData"];
    /** The list's page under Configurations (`/tenancy/systemSettings/<page>`), which request notices open; defaults to the collection name. */
    page?: string;
}): PlatformListOptions<T, TCreate> {
    const {model, service, collectionName, toDTO, buildCreateData} = config;
    const page = config.page ?? collectionName;
    const requestable = isRequestable(model);
    return {
        // The platform company manages it whether or not it runs the list's module (D195).
        platformListCollection: collectionName,
        // Reads, edits and deletes find the platform's rows (and the session company's own requests), never its own copy.
        documentFilter: (params) => platformListClause(params.company),
        // A select offers approved rows only, to every company.
        extraSelectFilter: () => platformRowsClause(),
        checkCreatePermission: (params) => {
            const {company, actionUserCtx, languageCode} = params;
            if (isPlatformCompany(company)) {
                SchemaGuard.checkModelPermission(model, "create", actionUserCtx, languageCode);
                return;
            }
            if (!requestable) throw apiValidationException("platform_company_required", "", null, languageCode);
            if (!hasActionPermission(model, "request", actionUserCtx)) {
                throw apiValidationException("user_permissions_not_sufficient", "", null, languageCode);
            }
        },
        buildCreateData: async (params) => {
            const data = await buildCreateData(params);
            if (isPlatformCompany(params.company)) return data;
            const platformId = await findPlatformCompanyId();
            if (!platformId) throw apiValidationException("platform_company_required", "", null, params.languageCode);
            return {
                ...data,
                company: platformId,
                requestStatus: "requested",
                requestedAt: new Date(),
                requestedBy: new ObjectId(String(params.actionUserCtx.userId)),
                requestedByCompany: params.company._id,
                requestedByCompanyName: params.company.name ?? "",
            };
        },
        afterCreate: async (created, params) => {
            if (created.requestStatus !== "requested") return;
            const platformId = await findPlatformCompanyId();
            if (platformId) await notifyEntryRequested(model, created, platformId, params, page);
        },
        editMiddleware: [platformCompanyOnly],
        beforeDelete: async (params, doc) => {
            assertPlatformCompany(params);
            // Deleting an entry that still waits is turning it down, without a reason.
            if (requestable && doc.requestStatus === "requested") {
                const {session, logger, languageCode, actionUserCtx} = params;
                await service.updateByIdOrThrow(doc._id, {$set: decisionSet("rejected", actionUserCtx.userId)}, {session, logger, languageCode, auditUserId: actionUserCtx.userId});
                notifyRequester(model, doc, NotificationEventCodes.ENTRY_REQUEST_REJECTED, params, page);
            }
            // Records of every company point at the shared row: count them all, not only the platform's.
            await asCrossTenant("a platform list row is used by every company's records", () =>
                assertCanDelete(model.modelName, doc._id, params.languageCode, params.session));
        },
        afterRestore: async (params, doc) => {
            assertPlatformCompany(params);
            // A rejected or withdrawn request is closed: its requester was told, or took it back. Restoring it would undo
            // that decision; the company requests the entry again instead (its code is free). Refused, so the restore rolls back.
            if (requestable && (doc.requestStatus === "rejected" || doc.requestStatus === "withdrawn")) {
                throw apiValidationException("entry_request_closed", "", null, params.languageCode);
            }
        },
        ...(requestable ? {
            actions: requestableActions({model, service, collectionName, toDTO, page}),
            enrichList: async (docs, params) => docs.map((doc) => withoutForeignRequest(toDTO(doc), params.company)),
            enrichSingle: async (doc, params) => withoutForeignRequest(toDTO(doc), params.company),
        } : {}),
    };
}
