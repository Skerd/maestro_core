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
 * standing in for "may do this".
 *
 * Rollout (D54): `ACTION_PERMISSION_ENFORCE` lists the modules whose actions are enforced (comma-separated,
 * `*` = all). Elsewhere a missing permission is only logged (`Action permission would refuse …`), so the
 * roles that would lose an action are found before enforcement spreads.
 */

type Scope = "self" | "others";

interface ModelAction {
    model: Model<any>;
    methodName: string;
}

const actions = new Map<string, ModelAction>();
const logger = getLogger("actionPermissions");
const reported = new Set<string>();

/** Records `methodName` as an action of `model`; `createRolePermissions` turns each into its tags. */
export function registerModelAction(model: Model<any>, methodName: string): void {
    actions.set(`${model.collection.name}:${methodName}`, {model, methodName});
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
    for (const {model, methodName} of actions.values()) {
        const key = model.collection.name;
        const group = key.charAt(0).toUpperCase() + key.slice(1);
        for (const scope of ["self", "others"] as const) {
            const tag = actionPermissionTag(model, methodName, scope);
            if (tag) entries.push({name: actionName(methodName), group, tag, alwaysActive: false, module: getModelModule(model.modelName)});
        }
    }
    return entries;
}

let enforcedRaw: string | undefined;
let enforcedModules: ReadonlySet<string> = new Set();

/** Whether action permissions are enforced for work of `module` (D54 rollout). Read on every call so tests can switch it. */
export function actionPermissionsEnforced(module: string | undefined): boolean {
    const raw = process.env.ACTION_PERMISSION_ENFORCE?.trim() ?? "";
    if (raw !== enforcedRaw) {
        enforcedRaw = raw;
        enforcedModules = new Set(raw.split(",").map((name) => name.trim()).filter(Boolean));
    }
    if (enforcedModules.has("*")) return true;
    return module !== undefined && enforcedModules.has(module);
}

/**
 * Refuses the action unless the caller's role holds its permission. Runs after `authMW`; acting as
 * another user (impersonation) needs the `others` tag, like the model permissions.
 */
export function actionPermissionMW(model: Model<any>, methodName: string): RequestHandler {
    return (req, _res, next) => {
        const ctx: UserContext | undefined = req.body?.actionUserCtx;
        const tag = actionPermissionTag(model, methodName, ctx?.isSelf === false ? "others" : "self");
        if (tag && ctx?.permissions?.includes(tag)) return next();
        const module = requestContext.getStore()?.routeModule;
        const label = tag ?? `${model.collection.name}[action:others:${methodName}]`;
        if (actionPermissionsEnforced(module)) {
            logger.warn(`Action permission refused ${label} for user ${ctx?.userId ?? "unknown"} in ${module ?? "no module"}`);
            return next(apiValidationException("user_permissions_not_sufficient", null, null, req.body?.languageCode ?? DEFAULT_EXCEPTION_LANGUAGE));
        }
        const key = `${label}|${ctx?.userId ?? ""}`;
        if (!reported.has(key)) {
            reported.add(key);
            logger.warn(`Action permission would refuse ${label} for user ${ctx?.userId ?? "unknown"} in ${module ?? "no module"}`);
        }
        next();
    };
}
