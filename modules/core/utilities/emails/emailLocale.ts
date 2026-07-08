import * as fs from "fs";
import * as path from "path";

/** Locale tags used for email copy files under `static/locales/<template>/{tag}.json`. */
export type EmailLocaleTag = "en-US" | "sq-AL";

const LOCALES_ROOT = path.join(__dirname, "static", "locales");

/**
 * Maps API/request language codes (e.g. `sq-AL`, `en-US`) to an email locale file tag.
 * Unknown or non-Albanian codes use `en-US`.
 */
export function resolveEmailLocaleTag(languageCode: string): EmailLocaleTag {
    const lc = (languageCode || "").trim().toLowerCase().replace(/_/g, "-");
    if (lc.startsWith("sq")) {
        return "sq-AL";
    }
    return "en-US";
}

export type EmailStrings = Record<string, string>;

/**
 * Loads strings from `<localesRoot>/<...relativePath>/{localeTag}.json`.
 * @param relativePathSegments path under the locales root, e.g. `["invitation"]` or `["forgotPassword"]`
 * @param localesRoot override for module-owned locale trees (default: core `static/locales`)
 */
export function loadEmailStrings(relativePathSegments: string[], languageCode: string, localesRoot: string = LOCALES_ROOT): EmailStrings {
    const localeTag = resolveEmailLocaleTag(languageCode);
    const filePath = path.join(localesRoot, ...relativePathSegments, `${localeTag}.json`);
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw) as EmailStrings;
}

/** Globally replace `{key}` placeholders (all occurrences). */
export function applyPlaceholders(template: string, values: Record<string, string>): string {
    let result = template;
    for (const [key, value] of Object.entries(values)) {
        result = result.split(`{${key}}`).join(value);
    }
    return result;
}
