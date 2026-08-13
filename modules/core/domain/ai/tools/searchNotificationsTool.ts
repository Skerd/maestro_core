/**
 * `search_notifications` — AI-assistant tool for the caller's own notifications.
 *
 * Answers "what did I miss?", "do I have anything unread?", "were there any
 * critical alerts this week?", "what security notifications did I get?".
 *
 * SCOPE IS THE CALLER, NOT THE COMPANY. Notifications are personal: they are
 * addressed to one recipient and routinely describe that person's own account
 * activity — sign-ins, IP addresses, password events. So the receiver filter is
 * pinned to {@link AssistantToolContext.userId} from trusted context, with no
 * argument that could point it at anybody else. There is deliberately no
 * "notifications for user X" capability here; that would turn a personal inbox
 * into a surveillance tool.
 *
 * @module searchNotificationsTool
 */

import {z} from "zod";
import {registerAssistantTool} from "@coreModule/domain/ai/tools/toolRegistry";
import type {AssistantTool, AssistantToolContext} from "@coreModule/domain/ai/tools/assistantTool.types";
import {notificationService} from "@coreModule/database/schemas/notification/notification.service";
import {NotificationImportance, NotificationStatus} from "@coreModule/database/schemas/notification/notification";
import {
    DEFAULT_RESULTS,
    callerObjectId,
    companyScope,
    dateRange,
    findOptions,
    limitArg,
    limitParameter,
    listResult,
    regexClause,
    shortText
} from "@coreModule/domain/ai/tools/assistantToolKit";

const IMPORTANCE_VALUES = Object.values(NotificationImportance) as string[];
const STATUS_VALUES = Object.values(NotificationStatus) as string[];

const SearchNotificationsArgs = z
    .object({
        search: z.string().trim().min(1).optional(),
        unreadOnly: z.coerce.boolean().optional(),
        importance: z.enum(IMPORTANCE_VALUES as [string, ...string[]]).optional(),
        status: z.enum(STATUS_VALUES as [string, ...string[]]).optional(),
        category: z.string().trim().min(1).optional(),
        since: z.coerce.date().optional(),
        until: z.coerce.date().optional(),
        limit: limitArg
    })
    .strip();

const parameters = {
    type: "object" as const,
    properties: {
        search: {type: "string", description: "Free text matched against the notification's description or code."},
        unreadOnly: {type: "boolean", description: "true = only notifications the user has not read yet."},
        importance: {
            type: "string",
            enum: IMPORTANCE_VALUES,
            description: "Importance level: low, normal, medium, high, or critical."
        },
        status: {
            type: "string",
            enum: STATUS_VALUES,
            description: "Kind of notification: success, error, warning, or info."
        },
        category: {type: "string", description: "Notification category, e.g. \"security\"."},
        since: {type: "string", description: "ISO date; only notifications on or after this date."},
        until: {type: "string", description: "ISO date; only notifications on or before this date."},
        limit: limitParameter
    },
    required: [] as string[]
};

async function execute(rawArgs: unknown, ctx: AssistantToolContext): Promise<unknown> {
    const args = SearchNotificationsArgs.parse(rawArgs ?? {});

    // Company scope AND caller scope. `receiver` is set from trusted context and
    // is not overridable by any argument — see the module note.
    const query: Record<string, unknown> = {
        ...companyScope(ctx),
        receiver: callerObjectId(ctx)
    };

    if (args.search != null) {
        const rx = regexClause(args.search);
        query.$or = [{description: rx}, {code: rx}];
    }
    if (args.unreadOnly === true) query.readOn = null;
    if (args.importance) query.importance = args.importance;
    if (args.status) query.status = args.status;
    if (args.category != null) query.category = regexClause(args.category);

    const when = dateRange(args.since, args.until);
    if (when) query.date = when;

    const limit = args.limit ?? DEFAULT_RESULTS;

    // `content` and `metadata` are free-form payloads that can carry anything a
    // sender put there, so they are not selected — the human-readable
    // description is what a conversational answer needs.
    const notifications = await notificationService.find(
        query,
        findOptions(ctx),
        undefined,
        "code description date importance status category channels readOn",
        {date: -1},
        limit
    );

    const results = notifications.map((n: any) => ({
        id: n._id?.toString(),
        code: n.code ?? null,
        description: shortText(n.description, 300),
        date: n.date ?? null,
        importance: n.importance ?? null,
        status: n.status ?? null,
        category: n.category ?? null,
        channels: Array.isArray(n.channels) ? n.channels : [],
        read: n.readOn != null,
        readOn: n.readOn ?? null
    }));

    return listResult(
        notificationService,
        query,
        results,
        ctx,
        "These are the current user's own notifications only."
    );
}

export const searchNotificationsTool: AssistantTool = {
    name: "search_notifications",
    description:
        "Search the current user's own notifications. Filter by free text, unread " +
        "only, importance (low…critical), kind (success, error, warning, info), " +
        "category, or a date range. Returns each notification's code, description, " +
        "date, importance and read state, plus `total` — the true number of " +
        "matches. Use this for \"what did I miss\", \"do I have unread " +
        "notifications\", or \"what alerts did I get this week\". This tool only " +
        "ever returns the caller's own notifications — it cannot look up anyone " +
        "else's.",
    parameters,
    execute
};

/** Registered by the core tool bootstrap (registerAllAssistantTools). */
export function registerNotificationsAssistantTools(): void {
    registerAssistantTool(searchNotificationsTool);
}
