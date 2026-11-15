/**
 * Reusable mappers for Mongoose plugin data (softDeletePlugin, ownershipPlugin, requestablePlugin).
 * Use these to avoid duplicating mapping logic across entity DTOs.
 */

import type {ObjectId} from "mongodb";
import type {CompanyBlank} from "armonia/src/modules/core/dto/company.dto";
import type {SimpleBlankUser} from "armonia/src/modules/core/dto/user.dto";
import type {RequestableData, RequestStatus} from "armonia/src/modules/core/types/shared.types";
import {CompanyBlankSnippet} from "@coreModule/database/schemas/company/company.snippets";
import {SimpleBlankUserSnippet} from "@coreModule/database/schemas/user/user.snippets";
import {mapSnippet} from "@coreModule/utilities/mappers/common.mapper";

/** User ref shape: populated doc or unpopulated ObjectId */
export type UserRefSource =
    | ObjectId
    | { _id?: ObjectId; name?: string; surname?: string; fullName?: string }
    | null
    | undefined;

/** Output shape for User ref in DTOs (_id, name, surname required for DeletedData compat) */
export type UserRefDTO = SimpleBlankUser;

/**
 * Maps a User ref (ObjectId or populated) to the DTO shape.
 * Handles both populated doc and unpopulated ObjectId.
 */
export function mapUserRefToDTO(userRef: UserRefSource): UserRefDTO | undefined {
    if (!userRef) return undefined;

    const isPopulated = typeof userRef === "object" && "_id" in userRef;
    const doc = isPopulated ? (userRef as { _id?: ObjectId; name?: string; surname?: string }) : null;
    const id = doc ? doc._id?.toString() : (userRef as ObjectId).toString();
    if (!id) return undefined;

    return {
        _id: id,
        name: doc?.name ?? "",
        surname: doc?.surname ?? "",
    };
}

/** Doc shape with soft delete plugin fields */
export type SoftDeleteDoc = {
    deletedAt?: Date | null;
    deletedBy?: UserRefSource;
};

/** Output shape for soft delete plugin data (DeletedData compatible) */
export type SoftDeleteDTO = {
    deletedAt?: Date;
    deletedBy?: UserRefDTO;
};

/**
 * Maps softDeletePlugin fields to the DTO shape.
 * Returns an object to spread into entity DTOs. Only includes keys when values exist.
 */
export function mapSoftDeleteToDTO<T extends SoftDeleteDoc>(doc: T): Partial<SoftDeleteDTO> {
    const result: Partial<SoftDeleteDTO> = {};
    if (doc.deletedAt) result.deletedAt = doc.deletedAt;
    const deletedBy = mapUserRefToDTO(doc.deletedBy);
    if (deletedBy) result.deletedBy = deletedBy;
    return result;
}

/** Doc shape with ownership plugin fields */
export type OwnershipDoc = {
    createdBy?: UserRefSource;
    company?: any;
};

/** Output shape for ownershipPlugin fields */
export type OwnershipDTO = {
    createdBy?: SimpleBlankUser;
    company?: CompanyBlank;
};

/**
 * Maps ownershipPlugin fields to the DTO shape.
 * `company` is included only when it maps through CompanyBlankSnippet (typically populated).
 */
export function mapOwnershipToDTO<T extends OwnershipDoc>(doc: T): Partial<OwnershipDTO> {
    const result: Partial<OwnershipDTO> = {};
    const createdBy = mapSnippet<SimpleBlankUser>()(doc.createdBy, SimpleBlankUserSnippet);
    if (createdBy) result.createdBy = createdBy;
    // CompanyBlank needs a populated name — bare ObjectIds stay off the wire.
    const company = mapSnippet<CompanyBlank>()(doc.company, CompanyBlankSnippet);
    if (company && typeof company.name === "string") result.company = company;
    return result;
}

export type LifeCycleDTO = {
    createdAt?: Date;
    updatedAt?: Date;
}

export function mapLifeCycleToDTO<T extends LifeCycleDTO>(doc: T): Partial<LifeCycleDTO> {
    return {
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt
    }
}
/** Doc shape with requestablePlugin fields */
export type RequestableDoc = {
    requestStatus?: RequestStatus;
    requestedAt?: Date;
    requestedBy?: UserRefSource;
    requestedByCompany?: ObjectId | null;
    requestedByCompanyName?: string;
    decidedAt?: Date;
    decidedBy?: UserRefSource;
    decisionNotes?: string;
};

/** Maps requestablePlugin fields to the DTO shape; rows from before the plugin read as approved. */
export function mapRequestableToDTO<T extends RequestableDoc>(doc: T): RequestableData {
    const requestedBy = mapSnippet<SimpleBlankUser>()(doc.requestedBy, SimpleBlankUserSnippet);
    const decidedBy = mapSnippet<SimpleBlankUser>()(doc.decidedBy, SimpleBlankUserSnippet);
    return {
        requestStatus: doc.requestStatus ?? "approved",
        ...(doc.requestedAt ? {requestedAt: doc.requestedAt} : {}),
        ...(requestedBy ? {requestedBy} : {}),
        ...(doc.requestedByCompany ? {requestedByCompany: doc.requestedByCompany.toString()} : {}),
        ...(doc.requestedByCompanyName ? {requestedByCompanyName: doc.requestedByCompanyName} : {}),
        ...(doc.decidedAt ? {decidedAt: doc.decidedAt} : {}),
        ...(decidedBy ? {decidedBy} : {}),
        ...(doc.decisionNotes ? {decisionNotes: doc.decisionNotes} : {}),
    };
}
