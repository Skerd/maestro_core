/**
 * The decisions on a requested entry of a requestable platform list (`requestablePlugin`, D160), mounted on the list's
 * router by `platformListRouteOptions`. Approving and rejecting are the platform company's (permission `decideRequest`),
 * whatever another company's roles hold; withdrawing is the requesting company's (permission `request`, the one that lets
 * it ask).
 *
 * @module api/requestableActions
 */

import {ObjectId} from "mongodb";
import type {Document, Model} from "mongoose";
import {action} from "@coreModule/api/actionDecorator";
import type {BaseCrudService} from "@coreModule/database/services/baseCrudService";
import type {IRequestablePluginFields} from "@coreModule/database/plugins/requestablePlugin";
import type {RequestStatus} from "armonia/src/modules/core/types/shared.types";
import type {TransactionRequiredParams} from "@coreModule/utilities/middlewares/transactionUtils";
import type {AuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import type {IOwnershipPluginFields} from "@coreModule/database/types/plugin-fields";
import {assertCanDelete} from "@coreModule/database/relationsRegistry";
import SchemaGuard from "@coreModule/database/security/schemaGuard";
import {getModelCollectedData} from "@coreModule/database/collections";
import {asCrossTenant, withTenant} from "@coreModule/utilities/endpoints/tenantScope";
import {assertPlatformCompany} from "@coreModule/utilities/security/platformAccess";
import {actionPermissionTag} from "@coreModule/utilities/security/actionPermissions";
import {nestedEntityToRef} from "@coreModule/utilities/mappers/common.mapper";
import {companyMemberIdsWithPermission} from "@coreModule/domain/roles/companyPermissionHolders";
import {emitNotificationEvent, NotificationEventCodes} from "@coreModule/domain/notifications/notificationEventBus";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {validateRejectRequestForm, validateSingleForm} from "armonia/src/modules/core/utilities/zod/shared.validator";

/** An entry of a requestable list: the plugin's fields, its owner and the name notifications show. */
export type RequestableEntry = Document & IRequestablePluginFields & IOwnershipPluginFields & {name?: string};

type DecisionParams = TransactionRequiredParams & {_id: string; notes?: string};

const RATE_LIMIT = {windowMs: 60000, max: 30};

/** The ids a notification about `entry` carries: its list page (under Configurations) and the entry to open there. */
function entryContent(page: string, entry: RequestableEntry) {
    return {list: page, entryId: entry._id.toString()};
}

/** Tells the platform's deciders that `requester` asked for `entry`; runs after the request is created. */
export async function notifyEntryRequested(
    model: Model<any>,
    entry: RequestableEntry,
    platformId: ObjectId,
    params: Pick<AuthenticatedMWType, "company" | "actionUserCtx" | "languageCode"> & {session?: TransactionRequiredParams["session"]},
    page: string,
): Promise<void> {
    // The platform's roles are read in its own tenant.
    const deciders = await withTenant(platformId, () =>
        companyMemberIdsWithPermission(platformId, actionPermissionTag(model, "decideRequest", "self")));
    emitNotificationEvent(NotificationEventCodes.ENTRY_REQUESTED, {
        receiverIds: deciders.filter((id) => id !== String(params.actionUserCtx.userId)),
        payload: {
            companyId: platformId.toString(),
            ...entryContent(page, entry),
            name: entry.name ?? "",
            requesterCompanyName: params.company.name ?? "",
            languageCode: params.languageCode ?? "en-US",
        },
        session: params.session,
    });
}

/** Tells whoever asked for `entry` how the platform decided; a rejection carries the platform's reason when it gave one. */
export function notifyRequester(
    model: Model<any>,
    entry: RequestableEntry,
    code: string,
    params: Pick<TransactionRequiredParams, "languageCode" | "session"> & {notes?: string},
    page: string,
): void {
    const requester = nestedEntityToRef(entry.requestedBy) ?? nestedEntityToRef(entry.createdBy);
    const requesterCompany = nestedEntityToRef(entry.requestedByCompany);
    if (!requester || !requesterCompany) return;
    const notes = params.notes?.trim() ?? "";
    emitNotificationEvent(code, {
        receiverIds: [requester.toString()],
        payload: {
            companyId: requesterCompany.toString(),
            ...entryContent(page, entry),
            name: entry.name ?? "",
            notes,
            ...(notes ? {variant: "withReason"} : {}),
            languageCode: params.languageCode ?? "en-US",
        },
        session: params.session,
    });
}

/** What a decision stores: the new status, who decided, when, and the reason when one is given. */
export function decisionSet(status: RequestStatus, userId: unknown, notes?: string): Record<string, unknown> {
    return {
        requestStatus: status,
        decidedAt: new Date(),
        decidedBy: new ObjectId(String(userId)),
        ...(notes?.trim() ? {decisionNotes: notes.trim()} : {}),
    };
}

/**
 * The actions class of a requestable list: `approve`, `reject` and `withdraw`, each only while the entry is requested
 * (`entry_request_not_pending`). Each records who decided and when; rejecting and withdrawing keep that status and delete
 * the entry, and refuse while any company's record still points at it.
 */
export function requestableActions<T extends RequestableEntry>(config: {
    model: Model<T>;
    service: BaseCrudService<T, Model<T>>;
    collectionName: string;
    toDTO: (doc: T) => unknown;
    /** The list's page under Configurations, which the notices open. */
    page: string;
}): new () => object {
    const {model, service, collectionName, toDTO, page} = config;

    async function requestedEntry(params: DecisionParams): Promise<T> {
        const {_id, session, logger, languageCode} = params;
        const entry = await service.findOneOrThrow({_id: new ObjectId(_id)}, {session, logger, languageCode, withDeleted: false});
        if (entry.requestStatus !== "requested") {
            throw apiValidationException("entry_request_not_pending", "", null, languageCode);
        }
        return entry;
    }

    /** Rejecting or withdrawing: the entry keeps who closed it and why, then is deleted. */
    async function closeEntry(entry: T, status: RequestStatus, params: DecisionParams): Promise<void> {
        const {session, logger, languageCode, actionUserCtx} = params;
        const options = {session, logger, languageCode, auditUserId: actionUserCtx.userId};
        await service.updateByIdOrThrow(entry._id, {$set: decisionSet(status, actionUserCtx.userId, params.notes)}, options);
        await service.deleteById(entry._id, options);
        await asCrossTenant("a requested entry may already be referenced by its requester's records", () =>
            assertCanDelete(model.modelName, entry._id, languageCode, session));
    }

    /**
     * The decided entry as the list reads it (deleted ones included), so the panel replaces its row, card and sheet with
     * one copy: the same read fields and populates as the CRUD router's refetch after an update.
     */
    async function decidedDTO(entry: T, params: DecisionParams): Promise<unknown> {
        const {session, logger, languageCode, actionUserCtx} = params;
        const readFields = SchemaGuard.sanitizeFields(model, getModelCollectedData(collectionName).readFields!, "read", actionUserCtx, languageCode);
        const populate = SchemaGuard.generatePopulate(readFields, model.schema);
        const decided = await service.findOneOrThrow(
            {_id: entry._id},
            {session, logger, languageCode, withDeleted: true},
            populate.populate,
            populate.select || undefined,
        );
        return toDTO(decided);
    }

    class RequestableActions {

        /** Adds the requested entry to the list for every company (the platform corrects it first with the edit form). */
        @action({auth: "private", rateLimit: RATE_LIMIT, transaction: true, schema: validateSingleForm, permission: "decideRequest"})
        async approve(params: DecisionParams): Promise<unknown> {
            assertPlatformCompany(params);
            const entry = await requestedEntry(params);
            const {session, logger, languageCode, actionUserCtx} = params;
            await service.updateByIdOrThrow(entry._id, {$set: decisionSet("approved", actionUserCtx.userId)}, {session, logger, languageCode, auditUserId: actionUserCtx.userId});
            notifyRequester(model, entry, NotificationEventCodes.ENTRY_REQUEST_APPROVED, params, page);
            return decidedDTO(entry, params);
        }

        /** Turns the request down: the entry is deleted and the requester told why. */
        @action({auth: "private", rateLimit: RATE_LIMIT, transaction: true, schema: validateRejectRequestForm, permission: "decideRequest"})
        async reject(params: DecisionParams): Promise<unknown> {
            assertPlatformCompany(params);
            const entry = await requestedEntry(params);
            await closeEntry(entry, "rejected", params);
            notifyRequester(model, entry, NotificationEventCodes.ENTRY_REQUEST_REJECTED, params, page);
            return decidedDTO(entry, params);
        }

        /** Takes back a request the session company sent, while the platform has not decided it. */
        @action({auth: "private", rateLimit: RATE_LIMIT, transaction: true, schema: validateSingleForm, permission: "request"})
        async withdraw(params: DecisionParams): Promise<unknown> {
            const entry = await requestedEntry(params);
            if (!nestedEntityToRef(entry.requestedByCompany)?.equals(params.company._id)) {
                throw apiValidationException("entry_request_requester_only", "", null, params.languageCode);
            }
            await closeEntry(entry, "withdrawn", {...params, notes: undefined});
            return decidedDTO(entry, params);
        }
    }

    return RequestableActions;
}
