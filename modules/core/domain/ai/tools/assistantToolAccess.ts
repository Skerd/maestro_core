/**
 * Access checks for AI-assistant tools.
 *
 * WHY THIS EXISTS. Company scoping alone is the right boundary for operational
 * data everyone at a company already sees — units, snags, projects. It is NOT
 * sufficient for the records the panel itself puts behind a permission: the
 * audit trail, sign-in history, scheduled-job internals. Without a check here,
 * any employee could ask the assistant "when did the director last log in, and
 * from where?" and get an answer the UI would have refused them. The chat must
 * not be a way around the app's own access rules.
 *
 * The gate reads the caller's real role from the database using
 * {@link IUser.getCompanyAccess} — the same path the private API uses — so it
 * cannot be talked around by anything the model says.
 *
 * Tools call {@link requireCompanyAdmin} and, when it denies, return the
 * {@link accessDenied} envelope rather than throwing: a refusal the model can
 * explain politely is better than a tool error it has to guess at.
 *
 * This file exports no `register*AssistantTools` function, so the bootstrap
 * loader imports it and moves on.
 *
 * @module assistantToolAccess
 */

import {ObjectId} from "mongodb";
import type {AssistantToolContext} from "@coreModule/domain/ai/tools/assistantTool.types";
import {userService} from "@coreModule/database/schemas/user/user.service";
import type {IUser} from "@coreModule/database/schemas/user/user";

/** What a tool gets back when it asks whether the caller may proceed. */
export interface AccessDecision {
    allowed: boolean;
    isAdmin: boolean;
    /** Permission tags the caller holds in this company, for finer checks. */
    permissions: string[];
}

/** The shape a tool returns when the caller may not see what they asked for. */
export interface AccessDeniedResult {
    permissionDenied: true;
    message: string;
}

/**
 * Load the caller as a real user document. Returns `null` if the id does not
 * resolve — treated as "no access", never as "no restriction".
 */
export async function loadCaller(ctx: AssistantToolContext): Promise<IUser | null> {
    if (!ObjectId.isValid(ctx.userId)) return null;
    return userService.findOne({_id: new ObjectId(ctx.userId)}, {logger: ctx.logger});
}

/**
 * Resolve the caller's access within the conversation's company.
 *
 * Fails closed on every unexpected path: an unknown user, a user with no role in
 * this company, or an error resolving roles all yield `allowed: false`.
 */
export async function requireCompanyAdmin(ctx: AssistantToolContext): Promise<AccessDecision> {
    try {
        const caller = await loadCaller(ctx);
        if (!caller) {
            return {allowed: false, isAdmin: false, permissions: []};
        }
        const {isAdmin, permissions} = await caller.getCompanyAccess(new ObjectId(ctx.companyId));
        return {allowed: isAdmin, isAdmin, permissions};
    } catch (error: any) {
        ctx.logger?.warn?.(`Assistant admin check failed; denying access: ${error?.message ?? error}`);
        return {allowed: false, isAdmin: false, permissions: []};
    }
}

/** Build the standard refusal payload for a tool the caller may not use. */
export function accessDenied(what: string): AccessDeniedResult {
    return {
        permissionDenied: true,
        message: `You need administrator access in this company to see ${what}. ` +
            `Ask a company administrator if you need this information.`
    };
}
