import {requestContext} from "@coreModule/utilities/endpoints/requestContext";

/**
 * Names of a platform list row in each panel language (D195, D196): product and service categories store them on the
 * row, next to the English `name`.
 *
 * @module listNames
 */
export type ListNames = {en?: string; sq?: string; de?: string; fr?: string; it?: string};

export const LIST_NAME_LANGUAGES = ["en", "sq", "de", "fr", "it"] as const;

/** The `names` key of a panel language (`sq-AL` → `sq`), English for any other. */
export function listNameKey(languageCode: string | undefined): keyof ListNames {
    const key = (languageCode ?? "en").slice(0, 2).toLowerCase();
    return (LIST_NAME_LANGUAGES as readonly string[]).includes(key) ? key as keyof ListNames : "en";
}

/**
 * A row's name in the request's language, else its English `name`. For labels and public pages; a record keeps its
 * stored names, so reading never saves a translation.
 */
export function listDisplayName(
    row: {name?: string; names?: ListNames | null},
    languageCode = requestContext.getStore()?.languageCode,
): string {
    return row.names?.[listNameKey(languageCode)]?.trim() || row.name || "";
}

/** The text a select searches: the English name and every translation, lower-cased, so a row is found in any language. */
export function listSearchText(name: string | undefined, names: ListNames | null | undefined): string {
    return [...new Set([name, ...LIST_NAME_LANGUAGES.map((language) => names?.[language])]
        .filter((value): value is string => !!value && value.trim() !== "")
        .map((value) => value.trim().toLowerCase()))].join(" | ");
}
