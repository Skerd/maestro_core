import {ClientSession, ObjectId} from "mongodb";
import RolePermission from "@coreModule/database/schemas/rolePermission/rolePermission";

export type DefaultRoleDefinition = {
    name: string;
    slug: string;
    description?: string;
    isAdmin: boolean;
    isSignupDefault: boolean;
    canEdit: boolean;
    canDelete: boolean;
    /** Full CRUD RolePermission groups (exact `group` strings, e.g. `"Projects"`). */
    permissionGroups?: string[];
    /** Read-only RolePermission groups — only tags containing `[read:` are granted. */
    readPermissionGroups?: string[];
};

export const coreDefaultRoles: DefaultRoleDefinition[] = [
    {
        name: "SysAdmin",
        slug: "sys_admin",
        description: "Full system access across every module. Reserved — cannot be edited or deleted.",
        isAdmin: true,
        isSignupDefault: false,
        canEdit: false,
        canDelete: false,
    },
    {
        name: "General Administrator",
        slug: "general_administrator",
        description: "Full company administration. Reserved — cannot be edited or deleted.",
        isAdmin: true,
        isSignupDefault: false,
        canEdit: false,
        canDelete: false,
    },
    {
        name: "Web Client",
        slug: "webclient",
        description: "Assigned on public signup. Starts with no panel permissions until an administrator grants them.",
        isAdmin: false,
        isSignupDefault: true,
        canEdit: true,
        canDelete: false,
    },
    {
        name: "Agent",
        slug: "agent",
        description: "Legacy placeholder with no permissions. Prefer Sales Agent for the sales pipeline.",
        isAdmin: false,
        isSignupDefault: false,
        canEdit: true,
        canDelete: false,
    },
];

/** @deprecated Use `getDefaultRoles()`. Alias of core defaults only (no module packs). */
export const defaultRoles: DefaultRoleDefinition[] = coreDefaultRoles;

const registeredPacks: DefaultRoleDefinition[] = [];
const registeredSlugs = new Set<string>();

export function registerDefaultRoles(roles: DefaultRoleDefinition[]): void {
    for (const role of roles) {
        if (registeredSlugs.has(role.slug)) {
            continue;
        }
        registeredSlugs.add(role.slug);
        registeredPacks.push(role);
    }
}

export function getDefaultRoles(): DefaultRoleDefinition[] {
    return [...coreDefaultRoles, ...registeredPacks];
}

export function defaultRoleSlug(companyName: string, role: DefaultRoleDefinition): string {
    return companyName.toLowerCase() + (role.isAdmin ? ":reserved:" : ":default:") + role.slug;
}

export function roleHasPermissionPack(role: DefaultRoleDefinition): boolean {
    return (role.permissionGroups?.length ?? 0) > 0
        || (role.readPermissionGroups?.length ?? 0) > 0;
}

function uniqueObjectIds(ids: ObjectId[]): ObjectId[] {
    const seen = new Set<string>();
    const unique: ObjectId[] = [];
    for (const id of ids) {
        const key = id.toString();
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        unique.push(id);
    }
    return unique;
}

export async function resolveDefaultRolePermissionIds(
    role: DefaultRoleDefinition,
    session?: ClientSession | null,
): Promise<ObjectId[]> {
    const dbSession = session ?? null;
    if (role.isAdmin) {
        const all = await RolePermission.find().select("_id").session(dbSession);
        return all.map((permission) => permission._id);
    }

    const ownGroups = role.permissionGroups ?? [];
    const readGroups = role.readPermissionGroups ?? [];
    if (ownGroups.length === 0 && readGroups.length === 0) {
        return [];
    }

    const ids: ObjectId[] = [];

    if (ownGroups.length > 0) {
        const own = await RolePermission.find({group: {$in: ownGroups}}).select("_id").session(dbSession);
        ids.push(...own.map((permission) => permission._id));
    }

    if (readGroups.length > 0) {
        const reads = await RolePermission.find({group: {$in: readGroups}}).select("_id tag").session(dbSession);
        for (const permission of reads) {
            if (typeof permission.tag === "string" && permission.tag.includes("[read:")) {
                ids.push(permission._id);
            }
        }
    }

    return uniqueObjectIds(ids);
}
