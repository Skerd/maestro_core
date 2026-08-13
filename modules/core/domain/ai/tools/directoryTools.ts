/**
 * `get_my_context`, `search_users` and `search_roles` — AI-assistant tools for
 * "who am I" and "who else is here".
 *
 * `get_my_context` grounds the whole conversation: without it the assistant does
 * not know the caller's own name, role, or whether they are an administrator, so
 * it cannot answer "what can I do here?" or resolve "assigned to me" questions
 * confidently. `search_users` is the company directory, and `search_roles` lists
 * the roles that exist and how many people hold each.
 *
 * SECURITY — READ THIS BEFORE WIDENING THE PROJECTION. The User document holds
 * password hashes, MFA secrets, and the `requests` sub-tree of live password
 * reset / activation / invitation codes. Anything selected here is handed to a
 * language model and may be repeated to whoever is chatting. Both user-facing
 * tools therefore use an explicit allow-list of fields ({@link USER_FIELDS}) —
 * never a blanket projection, and never an exclusion list, which would leak any
 * sensitive field added to the schema later.
 *
 * @module directoryTools
 */

import {ObjectId} from "mongodb";
import {z} from "zod";
import {registerAssistantTool} from "@coreModule/domain/ai/tools/toolRegistry";
import type {AssistantTool, AssistantToolContext} from "@coreModule/domain/ai/tools/assistantTool.types";
import {userService} from "@coreModule/database/schemas/user/user.service";
import {roleService} from "@coreModule/database/schemas/role/role.service";
import {loadCaller} from "@coreModule/domain/ai/tools/assistantToolAccess";
import {
    DEFAULT_RESULTS,
    companyObjectId,
    companyScope,
    findOptions,
    limitArg,
    limitParameter,
    listResult,
    regexClause,
    userDisplayName
} from "@coreModule/domain/ai/tools/assistantToolKit";

/**
 * The ONLY user fields any assistant tool may read. Everything absent from this
 * list — password, mfaSecret, requests.*, finance, telegram — stays unread.
 */
const USER_FIELDS = "username name surname fullName timezone phoneNumber online isBot isVisitor " +
    "registerDate isEmailVerified roles companies";

/** Membership states a user can hold in a company. */
const ACTIVE_STATES = ["active", "inactive", "invited"];

/** Pull the caller's membership entry for this company out of the roles array. */
function companyMembership(user: any, companyId: ObjectId): any | undefined {
    return (user?.roles ?? []).find((entry: any) => {
        const id = entry?.company?._id ?? entry?.company;
        return id?.toString() === companyId.toString();
    });
}

/** Role names on a membership entry, whether the refs are populated or raw ids. */
function roleNames(membership: any): string[] {
    return (membership?.roles ?? [])
        .map((role: any) => role?.name)
        .filter((name: unknown): name is string => typeof name === "string");
}

// ── get_my_context ───────────────────────────────────────────────────────────

const parameters = {type: "object" as const, properties: {}, required: [] as string[]};

async function executeMyContext(_rawArgs: unknown, ctx: AssistantToolContext): Promise<unknown> {
    const companyId = companyObjectId(ctx);
    const caller = await loadCaller(ctx);

    if (!caller) {
        return {found: false, reason: "Could not resolve the current user."};
    }

    // Role names come from a populated read; the admin flag and permission tags
    // come from getCompanyAccess, the same resolver the private API uses.
    const populated: any = await userService.findOne(
        {_id: caller._id},
        findOptions(ctx),
        [{path: "roles.roles", select: "name slug clearanceLevel isAdmin"}],
        USER_FIELDS
    );

    const membership = companyMembership(populated ?? caller, companyId);
    const {isAdmin, permissions} = await caller.getCompanyAccess(companyId);

    return {
        found: true,
        user: {
            id: caller._id?.toString(),
            name: userDisplayName(populated ?? caller),
            username: (populated ?? caller).username ?? null,
            timezone: (populated ?? caller).timezone ?? null,
            phone: (populated ?? caller).phoneNumber ?? null,
            emailVerified: (populated ?? caller).isEmailVerified ?? false
        },
        company: {
            id: ctx.companyId,
            membershipStatus: membership?.active ?? null,
            lastLogin: membership?.lastLogin ?? null
        },
        access: {
            isAdmin,
            roles: roleNames(membership),
            permissionCount: permissions.length,
            // The full tag list is long and of no use to a conversational answer;
            // a sample is enough for the model to describe what the user can do.
            samplePermissions: permissions.slice(0, 25)
        },
        note: "Use this to answer questions about the current user ('who am I', 'what is my role', " +
            "'am I an admin'). For questions about OTHER people use search_users."
    };
}

export const getMyContextTool: AssistantTool = {
    name: "get_my_context",
    description:
        "Get the profile and access of the person you are currently talking to: " +
        "their name, username, timezone, membership status, last login, whether " +
        "they are a company administrator, which roles they hold and a sample of " +
        "their permissions. Takes no arguments. Use this for \"who am I\", \"what " +
        "is my role\", \"what am I allowed to do\", or before answering anything " +
        "that depends on the caller's own identity or authority.",
    parameters,
    execute: executeMyContext
};

// ── search_users ─────────────────────────────────────────────────────────────

const SearchUsersArgs = z
    .object({
        search: z.string().trim().min(1).optional(),
        roleName: z.string().trim().min(1).optional(),
        membershipStatus: z.enum(ACTIVE_STATES as [string, ...string[]]).optional(),
        onlineOnly: z.coerce.boolean().optional(),
        limit: limitArg
    })
    .strip();

const userParameters = {
    type: "object" as const,
    properties: {
        search: {type: "string", description: "Free text matched against the person's name, surname or username/email."},
        roleName: {type: "string", description: "Only people holding a role whose name matches this, e.g. \"Sales\"."},
        membershipStatus: {
            type: "string",
            enum: ACTIVE_STATES,
            description: "Membership state in this company: active, inactive, or invited."
        },
        onlineOnly: {type: "boolean", description: "true = only people currently online."},
        limit: limitParameter
    },
    required: [] as string[]
};

async function executeSearchUsers(rawArgs: unknown, ctx: AssistantToolContext): Promise<unknown> {
    const args = SearchUsersArgs.parse(rawArgs ?? {});
    const companyId = companyObjectId(ctx);

    // A user belongs to many companies, so the scope is membership in THIS one.
    // Bots and anonymous website visitors are not colleagues — both excluded.
    const query: Record<string, unknown> = {
        companies: companyId,
        isBot: {$ne: true},
        isVisitor: {$ne: true}
    };

    if (args.search != null) {
        const rx = regexClause(args.search);
        query.$or = [{name: rx}, {surname: rx}, {fullName: rx}, {username: rx}];
    }
    if (args.onlineOnly === true) query.online = true;
    if (args.membershipStatus) {
        query.roles = {$elemMatch: {company: companyId, active: args.membershipStatus}};
    }

    if (args.roleName != null) {
        const roles = await roleService.find(
            {...companyScope(ctx), name: regexClause(args.roleName)},
            findOptions(ctx),
            undefined,
            "_id",
            undefined,
            25
        );
        const roleIds = roles.map((r: any) => r._id).filter(Boolean);
        if (roleIds.length === 0) {
            return {
                total: 0,
                returned: 0,
                truncated: false,
                results: [],
                note: `No role matching "${args.roleName}" in this company.`
            };
        }
        // Both conditions must hold on the SAME membership entry, so the company
        // and the role are matched together rather than independently.
        query.roles = {$elemMatch: {company: companyId, roles: {$in: roleIds}}};
    }

    const limit = args.limit ?? DEFAULT_RESULTS;

    const users = await userService.find(
        query,
        findOptions(ctx),
        [{path: "roles.roles", select: "name slug"}],
        USER_FIELDS,
        {name: 1},
        limit
    );

    const results = users.map((u: any) => {
        const membership = companyMembership(u, companyId);
        return {
            id: u._id?.toString(),
            name: userDisplayName(u),
            username: u.username ?? null,
            phone: u.phoneNumber ?? null,
            timezone: u.timezone ?? null,
            online: u.online ?? false,
            membershipStatus: membership?.active ?? null,
            roles: roleNames(membership),
            lastLogin: membership?.lastLogin ?? null,
            registeredOn: u.registerDate ?? null
        };
    });

    return listResult(userService, query, results, ctx);
}

export const searchUsersTool: AssistantTool = {
    name: "search_users",
    description:
        "Search the people who belong to this company (the staff directory). " +
        "Filter by free text over name or username/email, by role name, by " +
        "membership status (active, inactive, invited), or only those online now. " +
        "Returns each person's name, username, phone, roles, membership status and " +
        "last login, plus `total` — the true number of matching people. Use this " +
        "for \"who works here\", \"who is on the sales team\", \"how do I contact " +
        "X\", or \"who has not accepted their invitation\". For the caller's own " +
        "details use get_my_context.",
    parameters: userParameters,
    execute: executeSearchUsers
};

// ── search_roles ─────────────────────────────────────────────────────────────

const SearchRolesArgs = z
    .object({
        search: z.string().trim().min(1).optional(),
        limit: limitArg
    })
    .strip();

const roleParameters = {
    type: "object" as const,
    properties: {
        search: {type: "string", description: "Free text matched against the role name."},
        limit: limitParameter
    },
    required: [] as string[]
};

async function executeSearchRoles(rawArgs: unknown, ctx: AssistantToolContext): Promise<unknown> {
    const args = SearchRolesArgs.parse(rawArgs ?? {});
    const companyId = companyObjectId(ctx);

    // Hard company scope — the only scope the tool is allowed to read.
    const query: Record<string, unknown> = companyScope(ctx);
    if (args.search != null) query.name = regexClause(args.search);

    const limit = args.limit ?? DEFAULT_RESULTS;

    const roles = await roleService.find(
        query,
        findOptions(ctx),
        undefined,
        "name slug clearanceLevel isAdmin isSignupDefault permissions",
        {clearanceLevel: -1},
        limit
    );

    // One count per role rather than a lookup: the role list is small, and this
    // keeps the membership match (company + role on the same entry) explicit.
    const results = await Promise.all(
        roles.map(async (r: any) => ({
            id: r._id?.toString(),
            name: r.name ?? null,
            slug: r.slug ?? null,
            clearanceLevel: r.clearanceLevel ?? null,
            isAdmin: r.isAdmin ?? false,
            isSignupDefault: r.isSignupDefault ?? false,
            permissionCount: Array.isArray(r.permissions) ? r.permissions.length : 0,
            userCount: await userService.count(
                {
                    companies: companyId,
                    isBot: {$ne: true},
                    isVisitor: {$ne: true},
                    roles: {$elemMatch: {company: companyId, roles: r._id}}
                },
                {logger: ctx.logger}
            )
        }))
    );

    return listResult(roleService, query, results, ctx);
}

export const searchRolesTool: AssistantTool = {
    name: "search_roles",
    description:
        "List the access roles defined in this company, optionally filtered by " +
        "name. For each role it returns the clearance level, whether it is an " +
        "administrator or signup-default role, how many permissions it grants and " +
        "how many people currently hold it, plus `total` — the true number of " +
        "roles. Use this for questions about roles, permission levels, or how many " +
        "people are administrators. To list the people in a role, use search_users " +
        "with roleName.",
    parameters: roleParameters,
    execute: executeSearchRoles
};

/** Registered by the core tool bootstrap (registerAllAssistantTools). */
export function registerDirectoryAssistantTools(): void {
    registerAssistantTool(getMyContextTool);
    registerAssistantTool(searchUsersTool);
    registerAssistantTool(searchRolesTool);
}
