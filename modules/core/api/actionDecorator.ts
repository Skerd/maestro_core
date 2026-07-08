import type {RequestHandler} from "express";
import type {ZodObject} from "zod";

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
     * Invoked via validateFormZod before the handler.
     */
    schema?: (lang: string, form: any) => ZodObject<any>;
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