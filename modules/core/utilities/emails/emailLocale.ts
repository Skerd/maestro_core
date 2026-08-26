import * as fs from "fs";
import * as path from "path";

/** Locale tags used for email copy files under `static/locales/<template>/{tag}.json`. */
export type EmailLocaleTag = "en-US" | "sq-AL" | "de-CH" | "fr-FR" | "it-IT";

const LOCALES_ROOT = path.join(__dirname, "static", "locales");

const FALLBACK_LOCALE_TAG: EmailLocaleTag = "en-US";

/** Language prefix (ISO 639-1) to email locale file tag. */
const LANGUAGE_PREFIX_TO_TAG: Record<string, EmailLocaleTag> = {
    sq: "sq-AL",
    de: "de-CH",
    fr: "fr-FR",
    it: "it-IT",
    en: "en-US",
};

/**
 * Maps API/request language codes (e.g. `sq-AL`, `de-CH`) to an email locale file tag.
 * Codes for languages the emails are not translated into use `en-US`.
 */
export function resolveEmailLocaleTag(languageCode: string): EmailLocaleTag {
    const lc = (languageCode || "").trim().toLowerCase().replace(/_/g, "-");
    const prefix = lc.split("-")[0];
    return LANGUAGE_PREFIX_TO_TAG[prefix] ?? FALLBACK_LOCALE_TAG;
}

export type EmailStrings = Record<string, string>;

/**
 * Loads strings from `<localesRoot>/<...relativePath>/{localeTag}.json`, falling back
 * to `en-US` for locale trees that do not carry the requested language yet.
 * @param relativePathSegments path under the locales root, e.g. `["invitation"]` or `["forgotPassword"]`
 * @param localesRoot override for module-owned locale trees (default: core `static/locales`)
 */
export function loadEmailStrings(relativePathSegments: string[], languageCode: string, localesRoot: string = LOCALES_ROOT): EmailStrings {
    const localeTag = resolveEmailLocaleTag(languageCode);
    const templateDir = path.join(localesRoot, ...relativePathSegments);

    const filePath = path.join(templateDir, `${localeTag}.json`);
    if (localeTag !== FALLBACK_LOCALE_TAG && !fs.existsSync(filePath)) {
        const raw = fs.readFileSync(path.join(templateDir, `${FALLBACK_LOCALE_TAG}.json`), "utf8");
        return JSON.parse(raw) as EmailStrings;
    }

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
