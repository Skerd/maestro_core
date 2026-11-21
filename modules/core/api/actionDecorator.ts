import type {RequestHandler} from "express";
import type {ZodObject} from "zod";
import type {ValidationContext} from "armonia/src/modules/core/helpers/zodBuilder";
import type {PortalBuyerTarget} from "@coreModule/utilities/security/portalBuyer";

const ACTION_REGISTRY = Symbol("actionRegistry");

export interface ActionOptions {
    /**
     * Authentication mode passed to authMW. Defaults to "private".
     * Pass false to skip authentication entirely (public action).
     */
    auth?: string | false;
    /**
     * When true, wraps the handler in a MongoDB transaction via transactionHandler().
     * Leave false (default) when the handler manages its own session internally.
     */
    transaction?: boolean;
    /** Rate limit applied to this action's route. */
    rateLimit?: {windowMs: number; max: number};
    /**
     * Extra middleware inserted after transactionHandler and before validateFormZod.
     * Use for mediaUploadMW or any other per-action middleware.
     */
    middleware?: RequestHandler[];
    /**
     * Zod schema factory (lang, form) => ZodObject for request body validation.
     * Invoked via validateFormZod before the handler, with the {@link ValidationContext} as its 5th argument (D116).
     */
    schema?: (lang: string, form: any, writePerms?: unknown, readPerms?: unknown, context?: ValidationContext) => ZodObject<any>;
    /**
     * Access is decided by the caller's own relation to the record, not by their role: their own record
     * (account, preferences, addresses) or one they are a party to (a marketplace order or bid). Any signed-in
     * user may call it and it is not a role permission (D14, SEC-02). The action MUST check that relation
     * itself (owner or party check on `actionUserCtx`), never trusting the body.
     */
    selfService?: boolean;
    /**
     * A portal buyer action (D143): names the company the record lives in, whose modules gate the action for a
     * portal-zone caller whose own company lacks the module (see `AuthMWOptions.portalBuyer`).
     */
    portalBuyer?: PortalBuyerTarget;
    /**
     * A member-company action (D172): from the portal zone, a signed-in user may run it for one of their companies named
     * in `actAs`, with their role's permission there (see `AuthMWOptions.memberCompany`). Off unless set.
     */
    memberCompany?: boolean;
    /**
     * The permission scope the action always needs (D65). Omitted, it follows the request (`self`, or `others`
     * when acting as another user). `"others"` is for an action on another user's record named in the body,
     * e.g. unlocking a colleague's account: only that scope's permission exists and is checked.
     */
    scope?: "others";
    /**
     * The permission this action is checked against, when several actions are one grant (D71): e.g. joining,
     * releasing and closing a website chat are all `answerWebsiteChats`. Omitted, the method name.
     */
    permission?: string;
}

export interface RegisteredAction {
    methodName: string;
    options: ActionOptions;
}

/**
 * Marks a class method as a POST action endpoint.
 * The path is derived from the method name: `generateFloorsUnits` → POST `/generateFloorsUnits`.
 * Place the decorated class in `{entity}.actions.ts` and pass it to `createCrudRouter` via `actions:`.
 *
 * @example
 * ```ts
 * export class EdificeActions {
 *   @action({ auth: "private", rateLimit: { windowMs: 60000, max: 10 } })
 *   async cancelModification(params: any) { ... }
 * }
 * ```
 */
export function action(options: ActionOptions = {}) {
    return function (target: any, propertyKey: string, _descriptor: PropertyDescriptor): void {
        if (!Object.prototype.hasOwnProperty.call(target.constructor, ACTION_REGISTRY)) {
            Object.defineProperty(target.constructor, ACTION_REGISTRY, {
                value: [] as RegisteredAction[],
                writable: true,
                configurable: true,
                enumerable: false,
            });
        }
        (target.constructor[ACTION_REGISTRY] as RegisteredAction[]).push({
            methodName: propertyKey,
            options,
        });
    };
}

/** Returns all @action-decorated methods registered on the given class. */
export function getRegisteredActions(ActionsClass: new () => any): RegisteredAction[] {
    return (ActionsClass as any)[ACTION_REGISTRY] ?? [];
}