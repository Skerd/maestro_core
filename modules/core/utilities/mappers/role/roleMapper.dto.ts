/**
 * DTO mapper for Role -> CompanyRoleType.
 * Centralizes mapping logic used in company roles list endpoint.
 *
 * Maps IRole documents with their permissions to the API response shape,
 * including permission grouping (self/others) and soft-delete metadata.
 */

import type {IRole} from "@coreModule/database/schemas/role/role";
import type {IRolePermission} from "@coreModule/database/schemas/rolePermission/rolePermission";
import type {ObjectId} from "mongodb";
import {mapOwnershipToDTO, mapSoftDeleteToDTO} from "@coreModule/utilities/mappers/plugin/pluginMappers.dto";
import {
    CompanyRole,
    CompanyRolePermission,
    GroupedPermissions,
    PermissionsGrouped,
} from "armonia/src/modules/core/api/company/private/roles/role.dto";

/** Permission doc shape used when mapping (partial projection: _id, group, tag) */
export type PermissionProjection = Pick<IRolePermission, "_id" | "group" | "tag">;

/**
 * Groups a flat list of permission mappings into self/others by tag.
 * Permissions with ":others:" in tag go to others; otherwise to self.
 */
function groupPermissionsByScope(permissionMappings: Array<{ _id: string; group: string; tag: string; active: boolean }>): GroupedPermissions {
    return permissionMappings.reduce((acc, perm) => {
        if (!acc[perm.group]) acc[perm.group] = { self: [], others: [] };
        const entry: CompanyRolePermission = {
            _id: perm._id,
            active: perm.active,
            group: perm.group,
            tag: perm.tag,
        };
        if (perm.tag.includes(":others:")) {
            acc[perm.group].others.push(entry);
        } else {
            acc[perm.group].self.push(entry);
        }
        return acc;
    }, {} as GroupedPermissions);
}

/**
 * Sorts grouped permissions by total count descending (groups with more permissions first).
 */
function sortGroupedByCount(grouped: GroupedPermissions): Record<string, PermissionsGrouped> {
    return Object.fromEntries(
        Object.entries(grouped).sort(
            ([, a], [, b]) => b.self.length + b.others.length - (a.self.length + a.others.length)
        )
    );
}

/** Normalizes permission refs to ObjectIds (handles both raw ObjectIds and populated docs). */
function toPermissionIds(permissions: unknown[]): ObjectId[] {
    return permissions
        .filter((p): p is ObjectId | { _id: ObjectId } => p != null)
        .map((p) => (typeof p === "object" && p !== null && "_id" in p ? (p as { _id: ObjectId })._id : (p as ObjectId)));
}

/**
 * Builds sorted, grouped permissions for a role from the full permission list.
 *
 * @param rolePermissions - Role's permission IDs (ObjectIds or populated IRolePermission)
 * @param allPermissions - Full list of permission docs (projection: _id, group, tag)
 * @returns Grouped and sorted permissions, or null if role has no permissions or list is empty
 */
export function mapRolePermissionsToGrouped(rolePermissions: unknown[] | null | undefined, allPermissions: PermissionProjection[]): Record<string, PermissionsGrouped> | null {
    const ids = toPermissionIds(rolePermissions ?? []);
    if (!allPermissions.length) return null;

    const permissionMappings = allPermissions.map((permission) => ({
        _id: permission._id.toString(),
        group: permission.group,
        tag: permission.tag,
        active: ids.some((id) => id.equals(permission._id)),
    }));

    const grouped = groupPermissionsByScope(permissionMappings);
    return sortGroupedByCount(grouped);
}

/**
 * Maps a single Role document to CompanyRoleType.
 *
 * @param role - IRole document (may have populated deletedBy)
 * @param allPermissions - Full list of permission docs (projection: _id, group, tag)
 * @returns CompanyRoleType DTO
 */
export function roleToDTO(role: IRole, allPermissions: PermissionProjection[]): CompanyRole {
    const sortedPermissions = mapRolePermissionsToGrouped(role.permissions ?? [], allPermissions);
    return {
        _id: role._id.toString(),
        name: role.name,
        slug: role.slug,
        canDelete: role.canDelete,
        canEdit: role.canEdit,
        ...(sortedPermissions && {permissions: sortedPermissions}),
        ...mapSoftDeleteToDTO(role),
        ...mapOwnershipToDTO(role)
    };
}

/**
 * Maps an array of Role documents to CompanyRoleType[], skipping failed mappings.
 *
 * @param roles - Array of IRole documents
 * @param allPermissions - Full list of permission docs
 * @returns Array of CompanyRoleType
 */
export function rolesToDTO(roles: IRole[], allPermissions: PermissionProjection[]): CompanyRole[] {
    const data: CompanyRole[] = [];
    for (const role of roles) {
        try {
            data.push(roleToDTO(role, allPermissions));
        } catch (error) {}
    }
    return data;
}
