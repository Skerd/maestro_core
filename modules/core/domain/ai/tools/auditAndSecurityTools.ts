/**
 * `search_audit_log` + `search_login_history` — AI-assistant tools for "who
 * changed this?" and "who signed in?".
 *
 * Answers "who edited this record and when?", "what changed on units
 * yesterday?", "have there been failed login attempts?", "when did X last sign
 * in and from where?".
 *
 * BOTH ARE PRIVILEGED. The audit trail and the sign-in log are exactly the data
 * the panel puts behind an administrator permission, and both describe named
 * individuals — who did what, from which IP, in which city. Company scope alone
 * would let any employee interrogate their colleagues through the chat. So both
 * tools check the caller's real role via
 * {@link module:assistantToolAccess.requireCompanyAdmin} and refuse otherwise.
 *
 * `search_login_history` degrades rather than refuses: a non-administrator is
 * silently narrowed to their OWN sign-in history, which is theirs to see, and
 * the result says so.
 *
 * DIFF REDACTION. Audit diffs record before/after values verbatim, which for the
 * users collection includes password hashes, MFA secrets and live reset codes.
 * {@link redactDiff} reports that such a field changed but never its values.
 *
 * @module auditAndSecurityTools
 */

import {ObjectId} from "mongodb";
import {z} from "zod";
import {registerAssistantTool} from "@coreModule/domain/ai/tools/toolRegistry";
import type {AssistantTool, AssistantToolContext} from "@coreModule/domain/ai/tools/assistantTool.types";
import {auditLogService} from "@coreModule/database/schemas/auditLog/auditLog.service";
import {loginHistoryService} from "@coreModule/database/schemas/loginHistory/loginHistory.service";
import {userService} from "@coreModule/database/schemas/user/user.service";
import {accessDenied, requireCompanyAdmin} from "@coreModule/domain/ai/tools/assistantToolAccess";
import {
    DEFAULT_RESULTS,
    callerObjectId,
    companyObjectId,
    companyScope,
    dateRange,
    findOptions,
    limitArg,
    limitParameter,
    listResult,
    regexClause,
    userDisplayName
} from "@coreModule/domain/ai/tools/assistantToolKit";

const AUDIT_ACTIONS = ["CREATE", "UPDATE", "DELETE", "RESTORE"];
const LOGIN_STATUSES = ["success", "failure"];

/**
 * Field names whose values must never reach the model. Matched as a
 * case-insensitive substring so `mfaSecret`, `requests.passwordReset.code` and
 * `refreshToken` are all caught by their stem.
 */
const SENSITIVE_FIELD_STEMS = [
    "password", "secret", "token", "mfa", "otp", "apikey", "api_key",
    "credential", "salt", "hash", "signature", "privatekey", "code"
];

/** Cap on how many changed fields are described per audit entry. */
const MAX_DIFF_FIELDS = 12;
/** Cap on the length of any single before/after value handed to the model. */
const MAX_VALUE_CHARS = 120;

function isSensitiveField(field: string): boolean {
    const lower = field.toLowerCase();
    return SENSITIVE_FIELD_STEMS.some((stem) => lower.includes(stem));
}

/** Render one before/after value compactly, without dumping a whole subtree. */
function renderValue(value: unknown): unknown {
    if (value == null) return null;
    if (typeof value === "string") {
        return value.length > MAX_VALUE_CHARS ? value.slice(0, MAX_VALUE_CHARS) + "…" : value;
    }
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (Array.isArray(value)) return `[${value.length} item(s)]`;
    const text = String(value);
    return text.length > MAX_VALUE_CHARS ? text.slice(0, MAX_VALUE_CHARS) + "…" : text;
}

/**
 * Turn a raw audit diff into something safe to show. Sensitive fields are
 * reported as having changed, with their values replaced — the fact of the
 * change is useful, the credential is not.
 *
 * Exported so the redaction can be verified directly: whether a real audit row
 * with a password diff happens to exist in a given database is an accident of
 * data, and this guarantee should not depend on one.
 */
export function redactDiff(diff: unknown): {changes: any[]; fieldsChanged: number; redactedFields: string[]} {
    if (!diff || typeof diff !== "object") {
        return {changes: [], fieldsChanged: 0, redactedFields: []};
    }

    const entries = Object.entries(diff as Record<string, any>);
    const redactedFields: string[] = [];
    const changes: any[] = [];

    for (const [field, entry] of entries.slice(0, MAX_DIFF_FIELDS)) {
        if (isSensitiveField(field)) {
            redactedFields.push(field);
            changes.push({field, from: "[redacted]", to: "[redacted]"});
            continue;
        }
        changes.push({field, from: renderValue(entry?.from), to: renderValue(entry?.to)});
    }

    return {changes, fieldsChanged: entries.length, redactedFields};
}

// ── search_audit_log ─────────────────────────────────────────────────────────

const SearchAuditLogArgs = z
    .object({
        collectionName: z.string().trim().min(1).optional(),
        documentId: z.string().trim().min(1).optional(),
        action: z.enum(AUDIT_ACTIONS as [string, ...string[]]).optional(),
        actorName: z.string().trim().min(1).optional(),
        since: z.coerce.date().optional(),
        until: z.coerce.date().optional(),
        limit: limitArg
    })
    .strip();

const auditParameters = {
    type: "object" as const,
    properties: {
        collectionName: {
            type: "string",
            description: "Collection that was changed, e.g. \"units\", \"sales\", \"leads\" (lowercase plural)."
        },
        documentId: {type: "string", description: "The id of one specific record, to see its full change history."},
        action: {
            type: "string",
            enum: AUDIT_ACTIONS,
            description: "Kind of change: CREATE, UPDATE, DELETE, or RESTORE."
        },
        actorName: {type: "string", description: "Only changes made by the person whose name or username matches this."},
        since: {type: "string", description: "ISO date; only changes on or after this date."},
        until: {type: "string", description: "ISO date; only changes on or before this date."},
        limit: limitParameter
    },
    required: [] as string[]
};

/** Resolve people by name/username within the company, for the actor filter. */
async function resolveUserIds(name: string, ctx: AssistantToolContext): Promise<ObjectId[]> {
    const rx = regexClause(name);
    const users = await userService.find(
        {companies: companyObjectId(ctx), $or: [{name: rx}, {surname: rx}, {fullName: rx}, {username: rx}]},
        findOptions(ctx),
        undefined,
        "_id",
        undefined,
        25
    );
    return users.map((u: any) => u._id).filter(Boolean);
}

async function executeAuditLog(rawArgs: unknown, ctx: AssistantToolContext): Promise<unknown> {
    const args = SearchAuditLogArgs.parse(rawArgs ?? {});

    const access = await requireCompanyAdmin(ctx);
    if (!access.allowed) {
        return accessDenied("the change history (audit log)");
    }

    // Hard company scope — the only scope the tool is allowed to read.
    const query: Record<string, unknown> = companyScope(ctx);

    if (args.collectionName != null) query.collectionName = regexClause(args.collectionName);
    if (args.action) query.action = args.action;

    if (args.documentId != null) {
        if (!ObjectId.isValid(args.documentId)) {
            return {
                total: 0,
                returned: 0,
                truncated: false,
                results: [],
                note: `"${args.documentId}" is not a valid record id.`
            };
        }
        query.documentId = new ObjectId(args.documentId);
    }

    if (args.actorName != null) {
        const actorIds = await resolveUserIds(args.actorName, ctx);
        if (actorIds.length === 0) {
            return {
                total: 0,
                returned: 0,
                truncated: false,
                results: [],
                note: `No person matching "${args.actorName}" in this company.`
            };
        }
        query.actorId = {$in: actorIds};
    }

    const when = dateRange(args.since, args.until);
    if (when) query.createdAt = when;

    const limit = args.limit ?? DEFAULT_RESULTS;

    const entries = await auditLogService.find(
        query,
        findOptions(ctx),
        [{path: "actorId", select: "name surname fullName username"}],
        "documentId collectionName action actorId diff createdAt",
        {createdAt: -1},
        limit
    );

    const results = entries.map((e: any) => {
        const {changes, fieldsChanged, redactedFields} = redactDiff(e.diff);
        return {
            id: e._id?.toString(),
            collection: e.collectionName ?? null,
            documentId: e.documentId?.toString() ?? null,
            action: e.action ?? null,
            actor: userDisplayName(e.actorId),
            at: e.createdAt ?? null,
            fieldsChanged,
            changes,
            ...(changes.length < fieldsChanged
                ? {changesTruncated: `Showing ${changes.length} of ${fieldsChanged} changed fields.`}
                : {}),
            ...(redactedFields.length > 0
                ? {redactedFields: `Values hidden for sensitive fields: ${redactedFields.join(", ")}`}
                : {})
        };
    });

    return listResult(
        auditLogService,
        query,
        results,
        ctx,
        "Values of security-sensitive fields (passwords, secrets, tokens, codes) are redacted."
    );
}

export const searchAuditLogTool: AssistantTool = {
    name: "search_audit_log",
    description:
        "Search the change history (audit trail) of the company's records: who " +
        "created, updated, deleted or restored what, when, and which fields " +
        "changed from what to what. Filter by collection name, a specific record " +
        "id, action, the person who made the change, or a date range. Returns " +
        "`total` — the true number of matching changes. ADMINISTRATORS ONLY: if " +
        "the caller is not a company administrator the tool returns " +
        "`permissionDenied` and you should tell them plainly that this needs admin " +
        "access. Values of sensitive fields are redacted.",
    parameters: auditParameters,
    execute: executeAuditLog
};

// ── search_login_history ─────────────────────────────────────────────────────

const SearchLoginHistoryArgs = z
    .object({
        userName: z.string().trim().min(1).optional(),
        status: z.enum(LOGIN_STATUSES as [string, ...string[]]).optional(),
        since: z.coerce.date().optional(),
        until: z.coerce.date().optional(),
        limit: limitArg
    })
    .strip();

const loginParameters = {
    type: "object" as const,
    properties: {
        userName: {
            type: "string",
            description: "Only sign-ins by the person whose name or username matches this (administrators only)."
        },
        status: {
            type: "string",
            enum: LOGIN_STATUSES,
            description: "success for successful sign-ins, failure for rejected attempts."
        },
        since: {type: "string", description: "ISO date; only sign-ins on or after this date."},
        until: {type: "string", description: "ISO date; only sign-ins on or before this date."},
        limit: limitParameter
    },
    required: [] as string[]
};

async function executeLoginHistory(rawArgs: unknown, ctx: AssistantToolContext): Promise<unknown> {
    const args = SearchLoginHistoryArgs.parse(rawArgs ?? {});
    const access = await requireCompanyAdmin(ctx);

    // Hard company scope — the only scope the tool is allowed to read.
    const query: Record<string, unknown> = companyScope(ctx);
    let scopeNote: string;

    if (!access.allowed) {
        // Not an administrator: narrowed to their own sign-ins rather than
        // refused outright — a person's own login history is theirs to see.
        query.user = callerObjectId(ctx);
        scopeNote = "You are not a company administrator, so this shows only your own sign-in history.";
    } else if (args.userName != null) {
        const userIds = await resolveUserIds(args.userName, ctx);
        if (userIds.length === 0) {
            return {
                total: 0,
                returned: 0,
                truncated: false,
                results: [],
                note: `No person matching "${args.userName}" in this company.`
            };
        }
        query.user = {$in: userIds};
        scopeNote = `Sign-ins for people matching "${args.userName}".`;
    } else {
        scopeNote = "Sign-ins across the whole company.";
    }

    if (args.status) query.status = args.status;

    const when = dateRange(args.since, args.until);
    if (when) query.time = when;

    const limit = args.limit ?? DEFAULT_RESULTS;

    const history = await loginHistoryService.find(
        query,
        findOptions(ctx),
        [{path: "user", select: "name surname fullName username"}],
        "user time status mfa reason device os browser ip geolocation",
        {time: -1},
        limit
    );

    const results = history.map((h: any) => ({
        id: h._id?.toString(),
        user: userDisplayName(h.user),
        time: h.time ?? null,
        status: h.status ?? null,
        mfaUsed: h.mfa ?? false,
        failureReason: h.reason ?? null,
        device: h.device ?? null,
        os: h.os ?? null,
        browser: h.browser ?? null,
        ip: h.ip ?? null,
        location: [h.geolocation?.city, h.geolocation?.region, h.geolocation?.country]
            .filter(Boolean)
            .join(", ") || null
    }));

    return listResult(loginHistoryService, query, results, ctx, scopeNote);
}

export const searchLoginHistoryTool: AssistantTool = {
    name: "search_login_history",
    description:
        "Search sign-in history: successful logins and failed attempts, with the " +
        "person, time, device, browser, IP and approximate location, plus whether " +
        "MFA was used. Filter by person, success/failure, or a date range, and read " +
        "`total` for the true number of matches. Use this for security questions " +
        "such as failed login attempts or when someone last signed in. Company-wide " +
        "results and the userName filter require administrator access; other " +
        "callers automatically see only their own sign-ins, and the `note` says so.",
    parameters: loginParameters,
    execute: executeLoginHistory
};

/** Registered by the core tool bootstrap (registerAllAssistantTools). */
export function registerAuditAndSecurityAssistantTools(): void {
    registerAssistantTool(searchAuditLogTool);
    registerAssistantTool(searchLoginHistoryTool);
}
