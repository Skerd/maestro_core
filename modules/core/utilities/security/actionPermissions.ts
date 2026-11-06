import type {RequestHandler} from "express";
import type {Model} from "mongoose";
import {apiValidationException, DEFAULT_EXCEPTION_LANGUAGE} from "armonia/src/modules/core/helpers/exceptions";
import {getLogger} from "@coreModule/loggers/serverLog";
import {requestContext} from "@coreModule/utilities/endpoints/requestContext";
import {getModelModule} from "@coreModule/utilities/modules/modelModules";
import type {UserContext} from "@coreModule/utilities/types/types";

/**
 * Action permissions (D14, SEC-02). Every `@action` mounted on a model's router is a role permission of
 * that model, next to create/delete/restore: `reservations[action:self:cancel]` (`[action:cancel]` on a
 * "loose" model). Core checks it before the action's body runs, so the body needs no field-write checks
 * standing in for "may do this". Enforced in every module (D54: rolled out module by module, then made
 * unconditional).
 */

type Scope = "self" | "others";

interface ModelAction {
    model: Model<any>;
    methodName: string;
    /** The only scope the action has, when it declares one (`ActionOptions.scope`). */
    scope?: Scope;
}

const actions = new Map<string, ModelAction>();
const logger = getLogger("actionPermissions");

/** Records `methodName` as an action of `model`; `createRolePermissions` turns each into its tags. */
export function registerModelAction(model: Model<any>, methodName: string, scope?: Scope): void {
    actions.set(`${model.collection.name}:${methodName}`, {model, methodName, scope});
}

/** The tag for performing `methodName` on `model` in `scope`, or undefined where the model has no such scope. */
export function actionPermissionTag(model: Model<any>, methodName: string, scope: Scope): string | undefined {
    const key = model.collection.name;
    const loose = model.schema.get("accessMode") === "loose";
    if (loose) return scope === "self" ? `${key}[action:${methodName}]` : undefined;
    return `${key}[action:${scope}:${methodName}]`;
}

/** "reversePayment" → "Reverse payment": the fallback name of an action's permission. */
function actionName(methodName: string): string {
    const words = methodName.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
    return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Every registered action's permission rows, grouped under their model like its field and model tags. */
export function actionPermissionEntries(): {name: string; group: string; tag: string; alwaysActive: false; module: string}[] {
    const entries: {name: string; group: string; tag: string; alwaysActive: false; module: string}[] = [];
    for (const {model, methodName, scope: only} of actions.values()) {
        const key = model.collection.name;
        const group = key.charAt(0).toUpperCase() + key.slice(1);
        for (const scope of only ? [only] : (["self", "others"] as const)) {
            const tag = actionPermissionTag(model, methodName, scope);
            if (tag) entries.push({name: actionName(methodName), group, tag, alwaysActive: false, module: getModelModule(model.modelName)});
        }
    }
    return entries;
}

/**
 * Refuses the action unless the caller's role holds its permission. Runs after `authMW`; acting as
 * another user (impersonation) needs the `others` tag, like the model permissions. An action that declares
 * its `scope` always needs that scope's tag.
 */
export function actionPermissionMW(model: Model<any>, methodName: string, scope?: Scope): RequestHandler {
    return (req, _res, next) => {
        const ctx: UserContext | undefined = req.body?.actionUserCtx;
        const tag = actionPermissionTag(model, methodName, scope ?? (ctx?.isSelf === false ? "others" : "self"));
        if (tag && ctx?.permissions?.includes(tag)) return next();
        const label = tag ?? `${model.collection.name}[action:others:${methodName}]`;
        const module = requestContext.getStore()?.routeModule ?? "no module";
        logger.warn(`Action permission refused ${label} for user ${ctx?.userId ?? "unknown"} in ${module}`);
        next(apiValidationException("user_permissions_not_sufficient", null, null, req.body?.languageCode ?? DEFAULT_EXCEPTION_LANGUAGE));
    };
}
