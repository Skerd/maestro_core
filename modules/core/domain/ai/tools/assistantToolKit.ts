/**
 * Shared building blocks for AI-assistant tools, in any module.
 *
 * These are the mechanics every list-style tool repeats: the company scope, the
 * result envelope, regex escaping, Decimal128 parsing, date/number ranges. They
 * live in core because core owns the tool contract — modules import from here,
 * never the other way round.
 *
 * THE COUNT CONTRACT. A tool returns at most {@link MAX_RESULTS} rows, but the
 * model is routinely asked "how many". Returning only the page would make it
 * answer "10" for a company with 400 records — a confidently wrong number, which
 * is worse than no answer. {@link listResult} therefore always issues a real
 * `countDocuments` against the same filter and reports it as `total`, separate
 * from the `results` sample. Never hand-build an envelope that omits `total`.
 *
 * This file deliberately exports NO `register*AssistantTools` function: the
 * bootstrap loader scans every `.ts` in a tools directory and only calls exports
 * matching that name, so a helper module is imported and then ignored.
 *
 * @module assistantToolKit
 */

import {ObjectId} from "mongodb";
import {z} from "zod";
import type {AssistantToolContext} from "@coreModule/domain/ai/tools/assistantTool.types";

/** Hard cap on rows returned to the model, to protect its context window. */
export const MAX_RESULTS = 25;
/** Rows returned when the model does not ask for a specific `limit`. */
export const DEFAULT_RESULTS = 10;

/** Milliseconds in a day, for overdue/ageing arithmetic. */
const MS_PER_DAY = 86_400_000;

/** Escape a user/model-supplied string for safe use inside a RegExp. */
export function escapeRegex(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build a case-insensitive `$regex` clause from an untrusted term. */
export function regexClause(term: string): {$regex: string; $options: string} {
    return {$regex: escapeRegex(term), $options: "i"};
}

/**
 * Parse a Mongo numeric (Decimal128, number, or numeric string) into a plain
 * number for the JSON result, or `null` when absent/unparseable.
 */
export function toNumber(value: unknown): number | null {
    if (value == null) return null;
    const n = parseFloat(String(value));
    return Number.isFinite(n) ? n : null;
}

/** Like {@link toNumber} but returns 0 instead of null — for summing. */
export function toAmount(value: unknown): number {
    return toNumber(value) ?? 0;
}

/** Round a money total to 2dp so summed Decimal128 values don't show float dust. */
export function roundMoney(value: number): number {
    return Math.round(value * 100) / 100;
}

/** Best display name for a populated User, null-safe. */
export function userDisplayName(user: any): string | null {
    if (!user) return null;
    const full = [user.name, user.surname].filter(Boolean).join(" ").trim();
    return full || user.fullName || user.username || user.email || null;
}

/** Whole days from `date` until now; negative when `date` is in the future. */
export function daysOverdue(date: unknown): number | null {
    if (!date) return null;
    const then = new Date(date as any).getTime();
    if (!Number.isFinite(then)) return null;
    return Math.floor((Date.now() - then) / MS_PER_DAY);
}

/** Trim free text to a model-facing cap, null-safe. */
export function shortText(text: unknown, maxChars = 300): string | null {
    if (typeof text !== "string" || !text.trim()) return null;
    const trimmed = text.trim();
    return trimmed.length > maxChars ? trimmed.slice(0, maxChars) + "…" : trimmed;
}

/**
 * The hard company scope every tool query starts from. This is the ONLY scope a
 * tool may read; nothing the model says may widen it.
 */
export function companyScope(ctx: AssistantToolContext): Record<string, unknown> {
    return {company: new ObjectId(ctx.companyId)};
}

/** The company's ObjectId, for aggregation `$match` stages. */
export function companyObjectId(ctx: AssistantToolContext): ObjectId {
    return new ObjectId(ctx.companyId);
}

/** The asking user's ObjectId. Always from trusted context, never model input. */
export function callerObjectId(ctx: AssistantToolContext): ObjectId {
    return new ObjectId(ctx.userId);
}

/** Standard find options: soft-deleted rows are never visible to the assistant. */
export function findOptions(ctx: AssistantToolContext) {
    return {logger: ctx.logger, languageCode: ctx.languageCode, withDeleted: false};
}

/** Reusable `limit` argument, shared by every list tool. */
export const limitArg = z.coerce.number().int().positive().max(MAX_RESULTS).optional();

/** Reusable JSON-Schema fragment for the `limit` argument. */
export const limitParameter = {
    type: "integer",
    description: `Maximum number of rows to return (default ${DEFAULT_RESULTS}, max ${MAX_RESULTS}). ` +
        `The true number of matches is always reported separately as "total".`
};

/** The envelope every list tool returns. */
export interface ListEnvelope<T> {
    /** True number of records matching the filter — use THIS to answer "how many". */
    total: number;
    /** How many rows are included in `results` (a sample, capped by `limit`). */
    returned: number;
    /** Whether `results` is only part of the matches. */
    truncated: boolean;
    results: T[];
    note?: string;
}

/** Minimal service surface {@link listResult} needs. */
interface CountableService {
    count(query: any, options?: any): Promise<number>;
}

/**
 * Wrap a page of mapped rows in the standard envelope, issuing a real count
 * against the same filter so the model can answer "how many" correctly.
 *
 * The count is best-effort: if it fails, the envelope falls back to the page
 * size and carries a note saying so, rather than failing the whole tool call.
 */
export async function listResult<T>(
    service: CountableService,
    query: Record<string, unknown>,
    results: T[],
    ctx: AssistantToolContext,
    note?: string
): Promise<ListEnvelope<T>> {
    let total = results.length;
    let countNote = note;

    try {
        total = await service.count(query, {logger: ctx.logger, withDeleted: false});
    } catch (error: any) {
        ctx.logger?.warn?.(`Assistant tool count failed; reporting page size instead: ${error?.message ?? error}`);
        countNote = [note, "Exact total unavailable; 'total' reflects only the returned rows."]
            .filter(Boolean)
            .join(" ");
    }

    return {
        total,
        returned: results.length,
        truncated: total > results.length,
        results,
        ...(countNote ? {note: countNote} : {})
    };
}

/** An empty envelope with an explanatory note (e.g. a name matched nothing). */
export function emptyResult(note: string): ListEnvelope<never> {
    return {total: 0, returned: 0, truncated: false, results: [], note};
}

/**
 * Build an inclusive date-range clause from optional bounds, or `undefined`
 * when neither bound was supplied.
 */
export function dateRange(from?: Date, to?: Date): Record<string, Date> | undefined {
    if (!from && !to) return undefined;
    const clause: Record<string, Date> = {};
    if (from) clause.$gte = from;
    if (to) clause.$lte = to;
    return clause;
}

/**
 * Build a numeric range clause. Mongo compares Decimal128 to a plain number
 * correctly, so numbers are passed through unchanged.
 */
export function numberRange(min?: number, max?: number): Record<string, number> | undefined {
    if (min == null && max == null) return undefined;
    const clause: Record<string, number> = {};
    if (min != null) clause.$gte = min;
    if (max != null) clause.$lte = max;
    return clause;
}
