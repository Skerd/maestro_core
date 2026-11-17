import {requestContext} from "@coreModule/utilities/endpoints/requestContext";

const regionNames = new Map<string, Intl.DisplayNames | null>();

function namesFor(languageCode: string): Intl.DisplayNames | null {
    if (!regionNames.has(languageCode)) {
        let names: Intl.DisplayNames | null = null;
        try {
            names = new Intl.DisplayNames([languageCode], {type: "region", fallback: "none"});
        } catch {
            names = null;
        }
        regionNames.set(languageCode, names);
    }
    return regionNames.get(languageCode) ?? null;
}

/**
 * A country's name in the request's language, from its ISO code, else the stored (English) name, for labels only
 * (pickers, filter chips): a record keeps its stored name, so editing it never saves a translation (TD-F122).
 */
export function countryDisplayName(code: string | undefined | null, storedName: string, languageCode = requestContext.getStore()?.languageCode): string {
    if (!code || !languageCode || !/^[A-Za-z]{2}$/.test(code)) return storedName;
    try {
        return namesFor(languageCode)?.of(code.toUpperCase()) ?? storedName;
    } catch {
        return storedName;
    }
}
