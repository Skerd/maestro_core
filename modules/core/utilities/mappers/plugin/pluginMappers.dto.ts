/**
 * Reusable mappers for Mongoose plugin data (softDeletePlugin, ownershipPlugin).
 * Use these to avoid duplicating mapping logic across entity DTOs.
 */

import type {ObjectId} from "mongodb";

/** User ref shape: populated doc or unpopulated ObjectId */
export type UserRefSource =
    | ObjectId
    | { _id?: ObjectId; name?: string; surname?: string; fullName?: string }
    | null
    | undefined;

/** Output shape for User ref in DTOs (_id, name, surname required for DeletedData compat) */
export type UserRefDTO = {
    _id: string;
    name: string;
    surname: string;
};

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

/** Doc shape with ownership plugin createdBy field */
export type OwnershipDoc = {
    createdBy?: UserRefSource;
};

/** Output shape for ownership createdBy */
export type OwnershipDTO = {
    createdBy?: UserRefDTO;
};

/**
 * Maps ownershipPlugin createdBy field to the DTO shape.
 * Returns an object to spread into entity DTOs. Only includes createdBy when it exists.
 */
export function mapOwnershipToDTO<T extends OwnershipDoc>(doc: T): Partial<OwnershipDTO> {
    const createdBy = mapUserRefToDTO(doc.createdBy);
    return createdBy ? { createdBy } : {};
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