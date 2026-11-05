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
    /**
     * Groups whose sensitive fields (SEC-06: health, identity, payment data) this role also gets, within what
     * `permissionGroups` / `readPermissionGroups` grant. Every other group's sensitive tags are left out.
     */
    sensitivePermissionGroups?: string[];
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
];

const registeredPacks: DefaultRoleDefinition[] = [];
const registeredSlugs = new Set<string>();
const moduleBySlug = new Map<string, string>();

/**
 * Registers a module's default role pack. Bootstraps call this at import time without a
 * module; the module loader (ensureModuleDefaultRoles) calls it again with the module
 * name, which tags the pack so companies only get roles for their modules.
 */
export function registerDefaultRoles(roles: DefaultRoleDefinition[], moduleName?: string): void {
    for (const role of roles) {
        if (moduleName) {
            moduleBySlug.set(role.slug, moduleName);
        }
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

/**
 * Groups that registered default roles name but no permission has (`slug: group`). A misspelt group grants nothing
 * and says nothing, so the permission sync warns about each one at start-up (TD-B32).
 */
export function unknownDefaultRoleGroups(knownGroups: ReadonlySet<string>): string[] {
    const unknown = new Set<string>();
    for (const role of getDefaultRoles()) {
        for (const group of [...(role.permissionGroups ?? []), ...(role.readPermissionGroups ?? []), ...(role.sensitivePermissionGroups ?? [])]) {
            if (!knownGroups.has(group)) unknown.add(`${role.slug}: ${group}`);
        }
    }
    return [...unknown];
}

/** Core roles plus the packs of the given modules (untagged packs are always included). */
export function getDefaultRolesForModules(modules: string[]): DefaultRoleDefinition[] {
    const allowed = new Set(modules);
    return getDefaultRoles().filter((role) => {
        const moduleName = moduleBySlug.get(role.slug);
        return !moduleName || allowed.has(moduleName);
    });
}

export function defaultRoleSlug(companyName: string, role: DefaultRoleDefinition): string {
    return companyName.toLowerCase() + defaultRoleSuffix(role);
}

/** The part of a default role's slug that does not change when the company is renamed. */
export function defaultRoleSuffix(role: DefaultRoleDefinition): string {
    return (role.isAdmin ? ":reserved:" : ":default:") + role.slug;
}

/** Matches every slug a company's default roles may carry, whatever name the company had. */
export const DEFAULT_ROLE_SLUG_PATTERN = /:(reserved|default):[^:]+$/;

/**
 * A company's saved default roles grouped by definition. The slug starts with the company's
 * name at the time the role was made, so a renamed company's roles are found by suffix; more
 * than one per definition means the company got a second set after a rename.
 */
export function groupDefaultRoles<T extends {slug?: string}>(roles: T[], definitions: DefaultRoleDefinition[]): Map<DefaultRoleDefinition, T[]> {
    return new Map(definitions.map((definition) => {
        const suffix = defaultRoleSuffix(definition);
        return [definition, roles.filter((role) => role.slug?.endsWith(suffix))];
    }));
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
    // Sensitive tags (SEC-06) only come with the groups the role names for them.
    const notSensitiveUnlessListed = {
        $or: [
            {sensitivity: {$nin: ["health", "identity", "payment"]}},
            {group: {$in: role.sensitivePermissionGroups ?? []}},
        ],
    };

    if (ownGroups.length > 0) {
        const own = await RolePermission.find({group: {$in: ownGroups}, ...notSensitiveUnlessListed}).select("_id").session(dbSession);
        ids.push(...own.map((permission) => permission._id));
    }

    if (readGroups.length > 0) {
        const reads = await RolePermission.find({group: {$in: readGroups}, ...notSensitiveUnlessListed}).select("_id tag").session(dbSession);
        for (const permission of reads) {
            if (typeof permission.tag === "string" && permission.tag.includes("[read:")) {
                ids.push(permission._id);
            }
        }
    }

    return uniqueObjectIds(ids);
}
