/**
 * Role Access Cache
 *
 * Resolves the access facts that authMW needs for every private request — whether a
 * set of roles grants admin, and the flat list of permission tags those roles carry —
 * and caches the result in Redis, keyed per role.
 *
 * Why this exists:
 * `user.isAdmin()` and `user.getCompanyRolePermissions()` used to run one query each,
 * and the permission lookup resolved every permission ref through a Mongoose `populate`,
 * hydrating thousands of documents per request just to read their `tag` string. On a
 * SysAdmin role (>12k permission refs) that alone cost 60-100ms of every API call.
 *
 * Two things fix it:
 *  - The DB path is lean: two projected `.lean()` queries, no document hydration.
 *  - Results are cached per role in Redis, so warm requests do no database work at all.
 *
 * Keying by role (not by user) means a user's role assignment can change freely without
 * invalidation — the caller always passes the role ids it just read from the user
 * document. Only a change to the role itself invalidates, which RoleSchema does through
 * post-write hooks (see role.ts).
 *
 * Redis is optional: when it is not connected every helper degrades to the lean DB path,
 * so behaviour is identical with or without a cache — only the timing differs.
 *
 * Soft-deleted roles are always excluded (`.noDeleted()`), regardless of who is asking.
 * A deleted role must never grant access, and it keeps a cached entry from depending on
 * the requesting user's admin flag.
 */

import mongoose from "mongoose";
import {ObjectId} from "mongodb";
import {isRedisConnected, redisDel, redisMGet, redisSetEx} from "@coreModule/connections/connectToRedis";
import {REDIS} from "@coreModule/environment";

/** Access facts derived from a single role document. */
export type RoleAccess = {
    /** Whether this role grants administrator status. */
    isAdmin: boolean;
    /** Permission tags (e.g. `projects[read:self:name]`) this role carries. */
    tags: string[];
};

const KEY_PREFIX = "role_access:";

const cacheKey = (roleId: string): string => `${KEY_PREFIX}${roleId}`;

const toIdString = (roleId: ObjectId | string | { _id: ObjectId }): string =>
    (typeof roleId === "string" ? roleId : ((roleId as any)?._id ?? roleId)).toString();

/**
 * Reads roles from MongoDB and resolves their permission tags without hydrating documents.
 *
 * Two queries total regardless of how many roles are passed: one for the roles, one for
 * every permission they reference. Both are `.lean()` and projected down to the fields
 * actually used.
 *
 * @param roleIds - Role ids to resolve (already de-duplicated by the caller)
 * @returns Map of role id string -> access facts. Missing/deleted roles are absent.
 */
async function loadRoleAccessFromDb(roleIds: ObjectId[]): Promise<Map<string, RoleAccess>> {
    const Role = mongoose.model("Role");
    const RolePermission = mongoose.model("RolePermission");

    const roles = await (Role.find({_id: {$in: roleIds}}) as any)
        .noDeleted()
        .select("_id isAdmin permissions")
        .lean();

    const result = new Map<string, RoleAccess>();
    if (!roles.length) {
        return result;
    }

    // Permission refs can outlive the documents they point at (renamed/removed tags leave
    // dangling ids behind), so resolve the union once and drop whatever no longer exists.
    const allPermissionIds = new Set<string>();
    for (const role of roles) {
        for (const permissionId of (role.permissions ?? [])) {
            allPermissionIds.add(permissionId.toString());
        }
    }

    const permissionDocs = allPermissionIds.size > 0
        ? await RolePermission
            .find({_id: {$in: [...allPermissionIds].map((id) => new ObjectId(id))}})
            .select("_id tag")
            .lean()
        : [];

    const tagById = new Map<string, string>();
    for (const permission of permissionDocs as any[]) {
        if (permission.tag) {
            tagById.set(permission._id.toString(), permission.tag);
        }
    }

    for (const role of roles as any[]) {
        const tags = new Set<string>();
        for (const permissionId of (role.permissions ?? [])) {
            const tag = tagById.get(permissionId.toString());
            if (tag) {
                tags.add(tag);
            }
        }
        result.set(role._id.toString(), {isAdmin: role.isAdmin === true, tags: [...tags]});
    }

    return result;
}

/**
 * Resolves the combined access facts for a set of roles, using Redis when available.
 *
 * Cached roles are served from Redis in a single MGET; only the misses hit MongoDB, and
 * those are written back individually so other role combinations reuse them.
 *
 * @param roleIds - Roles held by the user in the company being accessed
 * @returns `isAdmin` true when any role is an admin role, and the union of all permission tags
 *
 * @example
 * ```typescript
 * const {isAdmin, tags} = await getRolesAccess(companyRole.roles.map((r) => r._id));
 * ```
 */
export async function getRolesAccess(roleIds: (ObjectId | string)[]): Promise<RoleAccess> {
    const uniqueIds = [...new Set((roleIds ?? []).map(toIdString))];
    if (uniqueIds.length === 0) {
        return {isAdmin: false, tags: []};
    }

    const resolved = new Map<string, RoleAccess>();
    const misses: string[] = [];

    if (isRedisConnected()) {
        const cached = await redisMGet(uniqueIds.map(cacheKey));
        uniqueIds.forEach((id, index) => {
            const raw = cached[index];
            if (!raw) {
                misses.push(id);
                return;
            }
            try {
                const parsed = JSON.parse(raw) as RoleAccess;
                resolved.set(id, {isAdmin: parsed.isAdmin === true, tags: parsed.tags ?? []});
            } catch {
                // Corrupt entry: treat as a miss and let the DB path overwrite it.
                misses.push(id);
            }
        });
    }
    else {
        misses.push(...uniqueIds);
    }

    if (misses.length > 0) {
        const fromDb = await loadRoleAccessFromDb(misses.map((id) => new ObjectId(id)));
        for (const [id, access] of fromDb) {
            resolved.set(id, access);
            void redisSetEx(cacheKey(id), REDIS.ROLE_ACCESS_CACHE_TTL, JSON.stringify(access));
        }
    }

    let isAdmin = false;
    const tags = new Set<string>();
    for (const access of resolved.values()) {
        isAdmin = isAdmin || access.isAdmin;
        for (const tag of access.tags) {
            tags.add(tag);
        }
    }

    return {isAdmin, tags: [...tags]};
}

/**
 * Drops cached access facts for the given roles.
 *
 * Called from RoleSchema post-write hooks, so any path that changes a role — the roles
 * API, the boot-time permission sync, a soft delete — invalidates without having to
 * remember to do it. A no-op when Redis is unavailable.
 *
 * @param roleIds - Roles whose cached entry is now stale
 */
export async function invalidateRoleAccess(roleIds: (ObjectId | string)[]): Promise<void> {
    if (!isRedisConnected()) {
        return;
    }
    const uniqueIds = [...new Set((roleIds ?? []).map(toIdString))];
    await Promise.all(uniqueIds.map((id) => redisDel(cacheKey(id))));
}
