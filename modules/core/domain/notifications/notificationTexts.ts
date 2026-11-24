import fs from "fs";
import path from "path";
import {CONSTANTS} from "@coreModule/environment";
import {
    createNotificationTypes,
    type NotificationTypes
} from "armonia/src/modules/core/helpers/notificationTypes";
import {
    createDefaultRoleLabels,
    type DefaultRoleLabels
} from "armonia/src/modules/core/helpers/defaultRoleLabels";

const REFERENCE_LANGUAGE = "en-US";

let texts: NotificationTypes | undefined;
let roleLabels: DefaultRoleLabels | undefined;

const fallbackLocales = (): string[] => [CONSTANTS.DEFAULT_LANGUAGE ?? REFERENCE_LANGUAGE, REFERENCE_LANGUAGE];

/** Every module's `armonia/src/modules/<module>/helpers/static/<folder>/*.json`, path → parsed JSON. */
function readArmoniaStatic(folder: string): Record<string, unknown> {
    const modulesRoot = path.join(path.dirname(require.resolve("armonia/package.json")), "src", "modules");
    const files: Record<string, unknown> = {};
    for (const entry of fs.readdirSync(modulesRoot, {withFileTypes: true})) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const dir = path.join(modulesRoot, entry.name, "helpers", "static", folder);
        if (!fs.existsSync(dir)) continue;
        for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".json"))) {
            const filePath = path.join(dir, file);
            files[filePath] = JSON.parse(fs.readFileSync(filePath, "utf8"));
        }
    }
    return files;
}

/** The notification texts (D128), read once. */
function loadTexts(): NotificationTypes {
    texts ??= createNotificationTypes({files: readArmoniaStatic("notificationTypes"), fallbackLocales: fallbackLocales()});
    return texts;
}

/** The default-role labels (D129), read once: a role notice names default roles in the receiver's language. */
function loadRoleLabels(): DefaultRoleLabels {
    roleLabels ??= createDefaultRoleLabels({files: readArmoniaStatic("defaultRoles"), fallbackLocales: fallbackLocales()});
    return roleLabels;
}

/**
 * The language a server-rendered notice (SMS, WhatsApp, Telegram) is written in for its receiver (D128): the receiver's
 * own `preferredLanguage`, else the instance's `DEFAULT_LANGUAGE`. Companies carry no language of their own, so there is
 * no company step.
 */
export function receiverLanguage(receiver: {preferredLanguage?: string | null} | null | undefined): string {
    return receiver?.preferredLanguage || CONSTANTS.DEFAULT_LANGUAGE || REFERENCE_LANGUAGE;
}

/**
 * A notification's text in `locale`, from the same files the panel reads (D117, D128): the variant `params.variant`
 * names, else the code's message, filled with `params`; a role notice's default roles are named in `locale` too (D129).
 * `null` when no module declares `code`, or when its message needs values and none were given; the caller then sends
 * the stored English `description`.
 *
 * @example notificationText("ROLE_ASSIGNED", {assigner: "Ada", role: "Sales"}, "de-CH")
 */
export function notificationText(code: string, params: Record<string, string | number> | undefined, locale: string): string | null {
    return loadTexts().notificationMessage({code, params: loadRoleLabels().translateRoleParams(params, locale)}, locale);
}

/** A role's name in `locale`, as a role notice names it (D129): a default role by its label, any other by its own name. */
export function roleNameIn(role: {slug?: string; name: string}, locale: string): string {
    return loadRoleLabels().translateDefaultRole(role, locale).name;
}

/**
 * The panel path a notification opens (D145), from the same files the panel reads: the code's `link` filled from the
 * notification's `content`. An email about the notice links to it on the panel host. `null` when there is none.
 */
export function notificationLink(code: string, content: Record<string, unknown> | undefined, locale: string): string | null {
    return loadTexts().notificationLink({code, content}, locale);
}
