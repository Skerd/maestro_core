import fs from "fs";
import path from "path";
import {CONSTANTS} from "@coreModule/environment";
import {
    createNotificationTypes,
    type NotificationTypes
} from "armonia/src/modules/core/helpers/notificationTypes";

const REFERENCE_LANGUAGE = "en-US";

let texts: NotificationTypes | undefined;

/** Every module's `armonia/src/modules/<module>/helpers/static/notificationTypes/*.json`, read once. */
function loadTexts(): NotificationTypes {
    if (texts) return texts;
    const modulesRoot = path.join(path.dirname(require.resolve("armonia/package.json")), "src", "modules");
    const files: Record<string, unknown> = {};
    for (const entry of fs.readdirSync(modulesRoot, {withFileTypes: true})) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const dir = path.join(modulesRoot, entry.name, "helpers", "static", "notificationTypes");
        if (!fs.existsSync(dir)) continue;
        for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".json"))) {
            const filePath = path.join(dir, file);
            files[filePath] = JSON.parse(fs.readFileSync(filePath, "utf8"));
        }
    }
    texts = createNotificationTypes({files, fallbackLocales: [CONSTANTS.DEFAULT_LANGUAGE ?? REFERENCE_LANGUAGE, REFERENCE_LANGUAGE]});
    return texts;
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
 * names, else the code's message, filled with `params`. `null` when no module declares `code`, or when its message needs
 * values and none were given; the caller then sends the stored English `description`.
 *
 * @example notificationText("ROLE_ASSIGNED", {assigner: "Ada", role: "Sales"}, "de-CH")
 */
export function notificationText(code: string, params: Record<string, string | number> | undefined, locale: string): string | null {
    return loadTexts().notificationMessage({code, params}, locale);
}
